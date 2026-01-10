import axios, { AxiosResponse } from 'axios';
import FormData from 'form-data';

export interface TaggunResponse {
  emailAddress: string;
  merchantName: string;
  merchantAddress: string;
  merchantPhone: string;
  merchantWebsite: string;
  merchantTaxId: string;
  merchantCategoryCode: number;
  currencyCode: string;
  totalAmount: number;
  taxAmount: number;
  tipAmount: number;
  feeAmount: number;
  discountAmount: number;
  paymentMethod: string;
  paymentMethodDetails: string;
  receiptNumber: string;
  purchaseDate: string;
  purchaseTime: string;
  confidence: number;
  processingTime: number;
  errorMessage: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    totalAmount: number;
    confidence: number;
  }>;
}

export class TaggunService {
  private apiKey: string;
  private apiUrl: string;

  constructor() {
    this.apiKey = process.env.TAGGUN_API_KEY || '';
    this.apiUrl = process.env.TAGGUN_API_URL || 'https://api.taggun.io/api/receipt/v1/verbose/file';
    
    console.log('🔑 Taggun API Key loaded:', this.apiKey ? 'YES' : 'NO');
    console.log('🌐 Taggun API URL:', this.apiUrl);
    
    if (!this.apiKey) {
      throw new Error('TAGGUN_API_KEY non configurata nelle variabili d\'ambiente');
    }
  }

  async processReceipt(imageBuffer: Buffer, filename: string): Promise<TaggunResponse> {
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: filename,
        contentType: this.getMimeType(filename),
      });
      formData.append('incognito', 'false');
      formData.append('refresh', 'false');
      formData.append('extract', 'lineItems,totalAmount,merchantName,merchantAddress,merchantPhone,merchantWebsite,merchantTaxId,merchantCategoryCode,currencyCode,taxAmount,tipAmount,feeAmount,discountAmount,paymentMethod,paymentMethodDetails,receiptNumber,purchaseDate,purchaseTime');

      const response: AxiosResponse<TaggunResponse> = await axios.post(
        this.apiUrl,
        formData,
        {
          headers: {
            'apiKey': `${Buffer.from(this.apiKey)}`,
            'Accept': 'application/json',
            ...formData.getHeaders(),
          },
          timeout: 30000,
        }
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const errorMessage = error.response?.data?.errorMessage || error.message;
        
        console.error(`Errore Taggun API (${statusCode}):`, errorMessage);
        
        if (statusCode === 401) {
          throw new Error('Autenticazione fallita: verificare la chiave API di Taggun');
        } else if (statusCode === 429) {
          throw new Error('Limite di richieste superato: riprovare più tardi');
        } else if (statusCode === 413) {
          throw new Error('File troppo grande: dimensione massima consentita 5MB');
        } else if (statusCode >= 500) {
          throw new Error('Errore del server Taggun: riprovare più tardi');
        } else {
          throw new Error(`Errore elaborazione ricevuta: ${errorMessage}`);
        }
      }
      
      console.error('Errore imprevisto nel servizio Taggun:', error);
      throw new Error('Errore interno durante l\'elaborazione della ricevuta');
    }
  }

  private getMimeType(filename: string): string {
    const extension = filename.toLowerCase().split('.').pop();
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'pdf':
        return 'application/pdf';
      default:
        return 'image/jpeg';
    }
  }

  async validateImageFile(imageBuffer: Buffer, filename: string): Promise<void> {
    const maxSize = 5 * 1024 * 1024; // 5MB
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    
    if (imageBuffer.length > maxSize) {
      throw new Error('Dimensione file superiore a 5MB');
    }
    
    const mimeType = this.getMimeType(filename);
    if (!allowedTypes.includes(mimeType)) {
      throw new Error('Formato file non supportato. Usare JPG, PNG o PDF');
    }
  }
}

export const taggunService = new TaggunService();
