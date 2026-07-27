import nodemailer from "nodemailer";
import { Resend } from "resend";

type BusinessDecisionStatus = "CONFIRMED" | "REFUSED";

type BusinessDecisionEmailInput = {
  recipientEmail: string;
  recipientName?: string | null;
  barName: string;
  businessName: string;
  status: BusinessDecisionStatus;
  rejectionReason?: string | null;
};

type EmailVerificationInput = {
  recipientEmail: string;
  recipientName?: string | null;
  verificationToken: string;
  expiresInHours: number;
};

type PasswordResetEmailInput = {
  recipientEmail: string;
  recipientName?: string | null;
  resetToken: string;
  expiresInMinutes: number;
};

export type EmailSendResult = {
  sent: boolean;
  skippedReason?: string;
  recipient: string;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maskValue(value: string | undefined | null): string {
  if (!value) return "not-set";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function normalizeEmailProvider(value: string | undefined): "auto" | "resend" | "smtp" {
  if (value === "resend" || value === "smtp") {
    return value;
  }
  return "auto";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

class EmailService {
  private resendClient: Resend | null = null;
  private resendInitialized = false;
  private transporter: nodemailer.Transporter | null = null;
  private initialized = false;

  private getResendConfig() {
    return {
      provider: normalizeEmailProvider(process.env.EMAIL_PROVIDER),
      apiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || "onboarding@resend.dev",
      fromName: process.env.RESEND_FROM_NAME || process.env.EMAIL_FROM_NAME || "Fidelty",
    };
  }

  private logResendConfig(context: string) {
    const config = this.getResendConfig();
    console.log(`📨 Resend ${context}`, {
      provider: config.provider,
      configured: Boolean(config.apiKey),
      fromEmail: config.fromEmail,
      fromName: config.fromName,
    });
  }

  private shouldUseResend() {
    const config = this.getResendConfig();
    if (config.provider === "resend") {
      return true;
    }
    if (config.provider === "smtp") {
      return false;
    }
    return Boolean(config.apiKey);
  }

  private shouldAllowSmtpFallback() {
    const config = this.getResendConfig();
    return config.provider === "auto";
  }

  private getResendClient(): Resend | null {
    if (this.resendInitialized) {
      return this.resendClient;
    }

    this.resendInitialized = true;

    const config = this.getResendConfig();
    if (!config.apiKey) {
      console.warn("⚠️ Resend non configurato: RESEND_API_KEY mancante");
      this.resendClient = null;
      return null;
    }

    this.logResendConfig("client initialized");
    this.resendClient = new Resend(config.apiKey);
    return this.resendClient;
  }

  private logEmailConfig(context: string) {
    const config = this.getConfig();
    console.log(`📮 EmailService ${context}`, {
      host: config.host || "not-set",
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTLS,
      connectionTimeout: config.connectionTimeout,
      greetingTimeout: config.greetingTimeout,
      socketTimeout: config.socketTimeout,
      tlsServername: config.tlsServername || "not-set",
      user: maskValue(config.user),
      fromEmail: config.fromEmail || "not-set",
    });
  }

  private async sendWithDefaultSender(input: {
    recipientEmail: string;
    subject: string;
    html: string;
    text: string;
    kind: string;
  }): Promise<EmailSendResult> {
    if (this.shouldUseResend()) {
      const resendClient = this.getResendClient();
      if (!resendClient) {
        throw new Error("Resend richiesto ma non configurato. Imposta RESEND_API_KEY.");
      }

      const resendConfig = this.getResendConfig();
      try {
        const resendResponse = await resendClient.emails.send({
          from: `${resendConfig.fromName} <${resendConfig.fromEmail}>`,
          to: input.recipientEmail,
          subject: input.subject,
          html: input.html,
          text: input.text,
        });

        if (resendResponse.error) {
          throw new Error(resendResponse.error.message || "Resend send failed");
        }

        console.log(`📨 Email ${input.kind} inviata via Resend a ${input.recipientEmail} usando ${resendConfig.fromEmail}`);
        return {
          sent: true,
          recipient: input.recipientEmail,
        };
      } catch (error) {
        this.logResendConfig(`send failure while sending ${input.kind}`);
        console.error(`❌ Email ${input.kind} failed via Resend`, {
          recipient: input.recipientEmail,
          message: error instanceof Error ? error.message : String(error),
        });

        if (!this.shouldAllowSmtpFallback()) {
          throw error;
        }
      }
    }

    const transporter = this.getTransporter();
    if (!transporter) {
      return {
        sent: false,
        skippedReason: "email_not_configured",
        recipient: input.recipientEmail,
      };
    }

    const { fromEmail, fromName } = this.getConfig();

    try {
      await transporter.sendMail({
        from: `${fromName} <${fromEmail}>`,
        sender: fromEmail,
        replyTo: fromEmail,
        to: input.recipientEmail,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
    } catch (error) {
      this.logEmailConfig(`send failure while sending ${input.kind}`);
      console.error(`❌ Email ${input.kind} failed`, {
        recipient: input.recipientEmail,
        code: (error as any)?.code || "unknown",
        command: (error as any)?.command || "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    console.log(`📧 Email ${input.kind} inviata a ${input.recipientEmail} usando ${fromEmail}`);
    return {
      sent: true,
      recipient: input.recipientEmail,
    };
  }

  private getConfig() {
    return {
      host: process.env.SMTP_HOST,
      port: parseNumber(process.env.SMTP_PORT, 587),
      secure: parseBoolean(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      fromEmail: process.env.EMAIL_FROM || process.env.SMTP_FROM,
      fromName: process.env.EMAIL_FROM_NAME || "Fidelty",
      requireTLS: parseBoolean(process.env.SMTP_REQUIRE_TLS, false),
      connectionTimeout: parseNumber(process.env.SMTP_CONNECTION_TIMEOUT_MS, 10000),
      greetingTimeout: parseNumber(process.env.SMTP_GREETING_TIMEOUT_MS, 10000),
      socketTimeout: parseNumber(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000),
      tlsServername: process.env.SMTP_TLS_SERVERNAME,
    };
  }

  private isConfigured(): boolean {
    const config = this.getConfig();
    return !!(config.host && config.port && config.user && config.pass && config.fromEmail);
  }

  private getTransporter(): nodemailer.Transporter | null {
    if (this.initialized) {
      return this.transporter;
    }

    this.initialized = true;

    if (!this.isConfigured()) {
      console.warn("⚠️ EmailService non configurato: SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/EMAIL_FROM mancanti");
      this.transporter = null;
      return null;
    }

    const config = this.getConfig();
    this.logEmailConfig("creating transporter with config");
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTLS,
      connectionTimeout: config.connectionTimeout,
      greetingTimeout: config.greetingTimeout,
      socketTimeout: config.socketTimeout,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      tls: {
        servername: config.tlsServername || config.host,
      },
    });

    return this.transporter;
  }

  private buildApprovalTemplate(input: BusinessDecisionEmailInput) {
    const recipientName = input.recipientName ? escapeHtml(input.recipientName) : "ciao";
    const barName = escapeHtml(input.barName);
    const businessName = escapeHtml(input.businessName);

    const subject = `Richiesta approvata: ${input.barName} ora e attivo su Fidelty`;
    const html = `
      <div style="margin:0;padding:32px;background:#f5f2fb;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f1730;">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 18px 48px rgba(44,28,84,0.08);">
          <div style="padding:28px 32px;background:linear-gradient(135deg,#8a63df 0%,#5fa2ff 100%);color:#fff;">
            <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.82;font-weight:700;">Fidelty</div>
            <h1 style="margin:14px 0 0;font-size:30px;line-height:1.1;">Richiesta approvata</h1>
            <p style="margin:12px 0 0;font-size:15px;line-height:1.6;opacity:0.92;">Il tuo bar e ora attivo sulla piattaforma.</p>
          </div>
          <div style="padding:32px;">
            <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">${recipientName}, la richiesta per <strong>${barName}</strong> (${businessName}) e stata approvata con successo.</p>
            <div style="padding:20px;border-radius:20px;background:#f7f4ff;border:1px solid rgba(113,87,186,0.16);margin-bottom:22px;">
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.12em;color:#6f61a2;font-weight:700;margin-bottom:12px;">Cosa cambia ora</div>
              <ul style="margin:0;padding-left:18px;color:#312648;line-height:1.8;">
                <li>il profilo del bar e stato attivato su Fidelty;</li>
                <li>puoi accedere alle funzionalita esclusive per i bar registrati;</li>
                <li>puoi gestire offerte, profilo e configurazioni direttamente dall'app.</li>
              </ul>
            </div>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5d556e;">Se non riconosci questa attivazione o hai bisogno di supporto, rispondi a questa email.</p>
            <div style="padding-top:18px;border-top:1px solid rgba(95,82,126,0.12);font-size:13px;color:#807791;line-height:1.7;">
              Questa e una comunicazione automatica inviata da Fidelty in seguito all'esito della tua richiesta di registrazione bar.
            </div>
          </div>
        </div>
      </div>
    `;
    const text = [
      `Ciao ${input.recipientName || ""},`,
      "",
      `la richiesta per ${input.barName} (${input.businessName}) e stata approvata con successo.`,
      "",
      "Cosa cambia ora:",
      "- il profilo del bar e attivo su Fidelty",
      "- puoi accedere alle funzionalita esclusive riservate ai bar registrati",
      "- puoi gestire offerte, profilo e configurazioni direttamente dall'app",
      "",
      "Se hai bisogno di supporto, rispondi a questa email.",
    ].join("\n");

    return { subject, html, text };
  }

  private buildRefusalTemplate(input: BusinessDecisionEmailInput) {
    const recipientName = input.recipientName ? escapeHtml(input.recipientName) : "ciao";
    const barName = escapeHtml(input.barName);
    const businessName = escapeHtml(input.businessName);
    const safeReason = input.rejectionReason ? escapeHtml(input.rejectionReason) : null;

    const subject = `Aggiornamento richiesta bar: ${input.barName} non e stata approvata`;
    const html = `
      <div style="margin:0;padding:32px;background:#f7f3f3;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#24191c;">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 18px 48px rgba(79,26,26,0.08);">
          <div style="padding:28px 32px;background:linear-gradient(135deg,#b85252 0%,#df7a5e 100%);color:#fff;">
            <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.82;font-weight:700;">Fidelty</div>
            <h1 style="margin:14px 0 0;font-size:30px;line-height:1.1;">Richiesta non approvata</h1>
            <p style="margin:12px 0 0;font-size:15px;line-height:1.6;opacity:0.92;">Ti inviamo l'esito della revisione della tua richiesta.</p>
          </div>
          <div style="padding:32px;">
            <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">${recipientName}, la richiesta per <strong>${barName}</strong> (${businessName}) non e stata approvata.</p>
            ${safeReason ? `
              <div style="padding:18px;border-radius:18px;background:#fff4f1;border:1px solid rgba(184,82,82,0.18);margin-bottom:20px;">
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.12em;color:#9a4f4f;font-weight:700;margin-bottom:10px;">Motivo</div>
                <div style="font-size:15px;line-height:1.7;color:#4d2e2e;">${safeReason}</div>
              </div>
            ` : ""}
            <div style="padding:20px;border-radius:20px;background:#faf7fb;border:1px solid rgba(95,82,126,0.12);margin-bottom:22px;">
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.12em;color:#6f617f;font-weight:700;margin-bottom:12px;">Cosa ne consegue</div>
              <ul style="margin:0;padding-left:18px;color:#3c3244;line-height:1.8;">
                <li>il bar non viene attivato sulla piattaforma;</li>
                <li>le funzionalita esclusive per i bar restano non disponibili;</li>
                <li>potrai inviare una nuova richiesta dopo aver corretto gli elementi necessari.</li>
              </ul>
            </div>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5d556e;">Se desideri riprovare, aggiorna i dati richiesti e invia una nuova richiesta di registrazione.</p>
          </div>
        </div>
      </div>
    `;
    const text = [
      `Ciao ${input.recipientName || ""},`,
      "",
      `la richiesta per ${input.barName} (${input.businessName}) non e stata approvata.`,
      input.rejectionReason ? `Motivo: ${input.rejectionReason}` : null,
      "",
      "Cosa ne consegue:",
      "- il bar non viene attivato sulla piattaforma",
      "- le funzionalita esclusive per i bar restano non disponibili",
      "- potrai inviare una nuova richiesta dopo aver corretto gli elementi necessari",
    ].filter(Boolean).join("\n");

    return { subject, html, text };
  }

  private buildEmailVerificationTemplate(input: EmailVerificationInput) {
    const recipientName = input.recipientName ? escapeHtml(input.recipientName) : "ciao";
    const safeToken = escapeHtml(input.verificationToken);
    const subject = "Verifica la tua email su Fidelty";
    const html = `
      <div style="margin:0;padding:32px;background:#f5f2fb;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f1730;">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 18px 48px rgba(44,28,84,0.08);">
          <div style="padding:28px 32px;background:linear-gradient(135deg,#8a63df 0%,#5fa2ff 100%);color:#fff;">
            <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.82;font-weight:700;">Fidelty</div>
            <h1 style="margin:14px 0 0;font-size:30px;line-height:1.1;">Conferma la tua email</h1>
            <p style="margin:12px 0 0;font-size:15px;line-height:1.6;opacity:0.92;">Completa la registrazione inserendo questo codice nell'app.</p>
          </div>
          <div style="padding:32px;">
            <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">${recipientName}, usa questo codice per verificare il tuo account Fidelty:</p>
            <div style="font-size:28px;font-weight:800;letter-spacing:0.12em;padding:18px 22px;border-radius:18px;background:#f7f4ff;border:1px solid rgba(113,87,186,0.16);display:inline-block;margin-bottom:22px;">${safeToken}</div>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#5d556e;">Il codice scade tra ${input.expiresInHours} ore.</p>
            <p style="margin:0;font-size:14px;line-height:1.7;color:#807791;">Se non hai richiesto la registrazione, puoi ignorare questa email.</p>
          </div>
        </div>
      </div>
    `;
    const text = [
      `Ciao ${input.recipientName || ""},`,
      "",
      "usa questo codice per verificare il tuo account Fidelty:",
      input.verificationToken,
      "",
      `Il codice scade tra ${input.expiresInHours} ore.`,
    ].join("\n");

    return { subject, html, text };
  }

  private buildPasswordResetTemplate(input: PasswordResetEmailInput) {
    const recipientName = input.recipientName ? escapeHtml(input.recipientName) : "ciao";
    const safeToken = escapeHtml(input.resetToken);
    const subject = "Reset password Fidelty";
    const html = `
      <div style="margin:0;padding:32px;background:#f5f2fb;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f1730;">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 18px 48px rgba(44,28,84,0.08);">
          <div style="padding:28px 32px;background:linear-gradient(135deg,#4c9a77 0%,#3a7bd5 100%);color:#fff;">
            <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.82;font-weight:700;">Fidelty</div>
            <h1 style="margin:14px 0 0;font-size:30px;line-height:1.1;">Reimposta la password</h1>
            <p style="margin:12px 0 0;font-size:15px;line-height:1.6;opacity:0.92;">Inserisci questo codice nell'app per scegliere una nuova password.</p>
          </div>
          <div style="padding:32px;">
            <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">${recipientName}, usa questo codice per completare il reset password:</p>
            <div style="font-size:28px;font-weight:800;letter-spacing:0.12em;padding:18px 22px;border-radius:18px;background:#f4fbf7;border:1px solid rgba(76,154,119,0.18);display:inline-block;margin-bottom:22px;">${safeToken}</div>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#5d556e;">Il codice scade tra ${input.expiresInMinutes} minuti.</p>
            <p style="margin:0;font-size:14px;line-height:1.7;color:#807791;">Se non hai richiesto il reset, ignora questa email e mantieni la tua password attuale.</p>
          </div>
        </div>
      </div>
    `;
    const text = [
      `Ciao ${input.recipientName || ""},`,
      "",
      "usa questo codice per reimpostare la password Fidelty:",
      input.resetToken,
      "",
      `Il codice scade tra ${input.expiresInMinutes} minuti.`,
    ].join("\n");

    return { subject, html, text };
  }

  async sendNewConsumptionRequestEmail(input: {
    recipientEmail: string;
    recipientName?: string | null;
    barName: string;
    requesterName: string;
    amount: number;
    pointsPreview: number;
    requestId: string;
  }): Promise<EmailSendResult> {
    const safeName = escapeHtml(input.recipientName || "ciao");
    const safeBar = escapeHtml(input.barName);
    const safeRequester = escapeHtml(input.requesterName);
    const amountStr = input.amount.toFixed(2).replace(".", ",");

    const subject = `Nuova richiesta consumazione — ${safeBar}`;
    const html = `
      <div style="margin:0;padding:32px;background:#f5f2fb;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f1730;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 12px 40px rgba(44,28,84,0.08);">
          <div style="padding:24px 32px;background:linear-gradient(135deg,#8a63df 0%,#5fa2ff 100%);color:#fff;">
            <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.82;font-weight:700;">Fidelty</div>
            <h1 style="margin:12px 0 0;font-size:26px;line-height:1.2;">Nuova richiesta punti</h1>
          </div>
          <div style="padding:28px 32px;">
            <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">${safeName}, <strong>${safeRequester}</strong> ha inviato una richiesta di consumazione al bar <strong>${safeBar}</strong>.</p>
            <div style="padding:18px;border-radius:16px;background:#f7f4ff;border:1px solid rgba(113,87,186,0.16);margin-bottom:20px;">
              <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6f61a2;margin-bottom:10px;">Dettagli richiesta</div>
              <div style="font-size:15px;color:#312648;line-height:1.8;">
                <div>Importo: <strong>€ ${amountStr}</strong></div>
                <div>Punti: <strong>${input.pointsPreview} pt</strong></div>
              </div>
            </div>
            <p style="margin:0 0 8px;font-size:14px;color:#807791;">Apri l'app Fidelty per approvare o rifiutare la richiesta.</p>
          </div>
        </div>
      </div>
    `;
    const text = [
      `Ciao ${input.recipientName || ""},`,
      "",
      `${input.requesterName} ha inviato una richiesta di consumazione al bar ${input.barName}.`,
      `Importo: € ${amountStr} — ${input.pointsPreview} punti`,
      "",
      "Apri l'app Fidelty per approvare o rifiutare la richiesta.",
    ].join("\n");

    return this.sendWithDefaultSender({
      recipientEmail: input.recipientEmail,
      subject,
      html,
      text,
      kind: "nuova richiesta consumazione",
    });
  }

  async sendBusinessRequestDecisionEmail(input: BusinessDecisionEmailInput): Promise<EmailSendResult> {
    const template = input.status === "CONFIRMED"
      ? this.buildApprovalTemplate(input)
      : this.buildRefusalTemplate(input);

    return this.sendWithDefaultSender({
      recipientEmail: input.recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
      kind: "esito business request",
    });
  }

  async sendEmailVerificationEmail(input: EmailVerificationInput): Promise<EmailSendResult> {
    const template = this.buildEmailVerificationTemplate(input);

    return this.sendWithDefaultSender({
      recipientEmail: input.recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
      kind: "verifica email",
    });
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<EmailSendResult> {
    const template = this.buildPasswordResetTemplate(input);

    return this.sendWithDefaultSender({
      recipientEmail: input.recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
      kind: "reset password",
    });
  }
}

export const emailService = new EmailService();