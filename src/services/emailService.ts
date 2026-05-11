import nodemailer from "nodemailer";

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

class EmailService {
  private transporter: nodemailer.Transporter | null = null;
  private initialized = false;

  private getConfig() {
    return {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: parseBoolean(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      fromEmail: process.env.EMAIL_FROM || process.env.SMTP_FROM,
      fromName: process.env.EMAIL_FROM_NAME || "Fidelty",
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
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
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

  async sendBusinessRequestDecisionEmail(input: BusinessDecisionEmailInput): Promise<EmailSendResult> {
    const transporter = this.getTransporter();
    if (!transporter) {
      return {
        sent: false,
        skippedReason: "email_not_configured",
        recipient: input.recipientEmail,
      };
    }

    const { fromEmail, fromName } = this.getConfig();
    const template = input.status === "CONFIRMED"
      ? this.buildApprovalTemplate(input)
      : this.buildRefusalTemplate(input);

    await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: input.recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    console.log(`📧 Email esito business request inviata a ${input.recipientEmail}`);
    return {
      sent: true,
      recipient: input.recipientEmail,
    };
  }

  async sendEmailVerificationEmail(input: EmailVerificationInput): Promise<EmailSendResult> {
    const transporter = this.getTransporter();
    if (!transporter) {
      return {
        sent: false,
        skippedReason: "email_not_configured",
        recipient: input.recipientEmail,
      };
    }

    const { fromEmail, fromName } = this.getConfig();
    const template = this.buildEmailVerificationTemplate(input);

    await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: input.recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    return {
      sent: true,
      recipient: input.recipientEmail,
    };
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<EmailSendResult> {
    const transporter = this.getTransporter();
    if (!transporter) {
      return {
        sent: false,
        skippedReason: "email_not_configured",
        recipient: input.recipientEmail,
      };
    }

    const { fromEmail, fromName } = this.getConfig();
    const template = this.buildPasswordResetTemplate(input);

    await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: input.recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    return {
      sent: true,
      recipient: input.recipientEmail,
    };
  }
}

export const emailService = new EmailService();