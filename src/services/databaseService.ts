import pkg from 'pg';
const { Pool } = pkg;

export class DatabaseService {
  private pool: pkg.Pool;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      throw new Error('DATABASE_URL non configurata nelle variabili d\'ambiente');
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
      },
    });

    console.log('🗄️  Pool di connessioni PostgreSQL inizializzato');
  }

  async initializeTables(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS receipts (
          id SERIAL PRIMARY KEY,
          doc_id VARCHAR(9) UNIQUE NOT NULL,
          merchant_name VARCHAR(255),
          merchant_address TEXT,
          merchant_phone VARCHAR(20),
          merchant_website VARCHAR(255),
          merchant_tax_id VARCHAR(50),
          merchant_category_code INT,
          currency_code VARCHAR(3),
          total_amount DECIMAL(10, 2),
          tax_amount DECIMAL(10, 2),
          tip_amount DECIMAL(10, 2),
          fee_amount DECIMAL(10, 2),
          discount_amount DECIMAL(10, 2),
          payment_method VARCHAR(100),
          payment_method_details VARCHAR(255),
          receipt_number VARCHAR(50),
          purchase_date DATE,
          purchase_time TIME,
          email_address VARCHAR(255),
          confidence DECIMAL(5, 2),
          processing_time INT,
          line_items JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS receipt_items (
          id SERIAL PRIMARY KEY,
          receipt_id INT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
          description VARCHAR(255),
          quantity DECIMAL(10, 2),
          unit_price DECIMAL(10, 2),
          total_amount DECIMAL(10, 2),
          confidence DECIMAL(5, 2),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_receipts_doc_id ON receipts(doc_id);
        CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at);
      `);
      console.log('✅ Tabelle del database inizializzate correttamente');
    } catch (error) {
      console.error('❌ Errore durante l\'inizializzazione delle tabelle:', error);
      throw error;
    }
  }

  async saveReceipt(receiptData: any): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const docId = receiptData.entities?.receiptNumber?.data || receiptData.receiptNumber;

      if (!docId) {
        throw new Error('Doc ID mancante nei dati della ricevuta');
      }

      const insertReceiptQuery = `
        INSERT INTO receipts (
          doc_id,
          merchant_name,
          merchant_address,
          merchant_phone,
          merchant_website,
          merchant_tax_id,
          merchant_category_code,
          currency_code,
          total_amount,
          tax_amount,
          tip_amount,
          fee_amount,
          discount_amount,
          payment_method,
          payment_method_details,
          receipt_number,
          purchase_date,
          purchase_time,
          email_address,
          confidence,
          processing_time,
          line_items
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        ON CONFLICT (doc_id) DO UPDATE SET
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;

      const receiptValues = [
        docId,
        receiptData.merchantName || null,
        receiptData.merchantAddress || null,
        receiptData.merchantPhone || null,
        receiptData.merchantWebsite || null,
        receiptData.merchantTaxId || null,
        receiptData.merchantCategoryCode || null,
        receiptData.currencyCode || null,
        receiptData.totalAmount || null,
        receiptData.taxAmount || null,
        receiptData.tipAmount || null,
        receiptData.feeAmount || null,
        receiptData.discountAmount || null,
        receiptData.paymentMethod || null,
        receiptData.paymentMethodDetails || null,
        receiptData.receiptNumber || null,
        receiptData.purchaseDate || null,
        receiptData.purchaseTime || null,
        receiptData.emailAddress || null,
        receiptData.confidence || null,
        receiptData.processingTime || null,
        JSON.stringify(receiptData.lineItems || []),
      ];

      const receiptResult = await client.query(insertReceiptQuery, receiptValues);
      const receiptId = receiptResult.rows[0].id;

      // Salva i line items se presenti
      if (receiptData.lineItems && Array.isArray(receiptData.lineItems)) {
        for (const item of receiptData.lineItems) {
          const insertItemQuery = `
            INSERT INTO receipt_items (
              receipt_id,
              description,
              quantity,
              unit_price,
              total_amount,
              confidence
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `;

          const itemValues = [
            receiptId,
            item.description || null,
            item.quantity || null,
            item.unitPrice || null,
            item.totalAmount || null,
            item.confidence || null,
          ];

          await client.query(insertItemQuery, itemValues);
        }
      }

      await client.query('COMMIT');
      console.log(`✅ Ricevuta salvata nel database con ID: ${receiptId}`);
      return receiptId;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Errore durante il salvataggio della ricevuta:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getReceipt(docId: string): Promise<any> {
    try {
      const query = 'SELECT * FROM receipts WHERE doc_id = $1';
      const result = await this.pool.query(query, [docId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Errore durante il recupero della ricevuta:', error);
      throw error;
    }
  }

  async closePool(): Promise<void> {
    await this.pool.end();
    console.log('🗄️  Pool di connessioni PostgreSQL chiuso');
  }
}

export const databaseService = new DatabaseService();
