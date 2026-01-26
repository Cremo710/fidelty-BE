import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';
export class TaggunApiError extends Error {
    statusCode;
    errorCode;
    constructor(message, statusCode = 500, errorCode = 'UNKNOWN_ERROR') {
        super(message);
        this.name = 'TaggunApiError';
        this.statusCode = statusCode;
        this.errorCode = errorCode;
    }
}
export class TaggunService {
    apiKey;
    apiUrl;
    constructor() {
        this.apiKey = process.env.TAGGUN_API_KEY || '';
        this.apiUrl = process.env.TAGGUN_API_URL || 'https://api.taggun.io/api/receipt/v1/verbose/file';
        console.log('🔑 Taggun API Key loaded:', this.apiKey ? 'YES' : 'NO');
        console.log('🌐 Taggun API URL:', this.apiUrl);
        if (!this.apiKey) {
            throw new Error('TAGGUN_API_KEY non configurata nelle variabili d\'ambiente');
        }
    }
    async processReceipt(imageBuffer, filename) {
        try {
            // Controlla la dimensione del file
            const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
            let processBuffer = imageBuffer;
            console.log(`📦 Dimensione file originale: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);
            if (imageBuffer.length > MAX_FILE_SIZE) {
                console.log('⚠️  File supera 20MB, tentativo di ridimensionamento...');
                const extension = filename.toLowerCase().split('.').pop();
                // Se è un'immagine, prova a ridimensionarla
                if (['jpg', 'jpeg', 'png'].includes(extension || '')) {
                    try {
                        processBuffer = await this.compressImage(imageBuffer, extension || 'jpeg');
                        console.log(`✅ Immagine ridimensionata: ${(processBuffer.length / 1024 / 1024).toFixed(2)}MB`);
                    }
                    catch (compressionError) {
                        console.error('❌ Errore durante il ridimensionamento:', compressionError);
                        throw new Error('File troppo grande (>20MB) e impossibile ridimensionare l\'immagine');
                    }
                }
                else {
                    throw new Error('File troppo grande (>20MB) e non è un\'immagine compressibile');
                }
            }
            const formData = new FormData();
            formData.append('file', processBuffer, {
                filename: filename,
                contentType: this.getMimeType(filename),
            });
            formData.append('incognito', 'false');
            formData.append('refresh', 'false');
            formData.append('extract', 'lineItems,totalAmount,merchantName,merchantAddress,merchantPhone,merchantWebsite,merchantTaxId,merchantCategoryCode,currencyCode,taxAmount,tipAmount,feeAmount,discountAmount,paymentMethod,paymentMethodDetails,receiptNumber,purchaseDate,purchaseTime');
            const response = await axios.post(this.apiUrl, formData, {
                headers: {
                    'apiKey': `${Buffer.from(this.apiKey)}`,
                    'Accept': 'application/json',
                    ...formData.getHeaders(),
                },
                timeout: 30000,
            });
            // Estrazione DOC ID dal campo text.text
            const textField = response.data?.text?.text;
            const docIdRegex = /(?:DOCUMENTO N\.|DOC\.|DOC N\.)\s*(\d{4}-\d{4})/i;
            if (!textField) {
                console.error('❌ Campo text.text non trovato nella response');
                throw new TaggunApiError('Impossibile estrarre il Doc ID', 500, 'DOC_ID_ERR');
            }
            const docIdMatch = textField.match(docIdRegex);
            if (!docIdMatch || !docIdMatch[1]) {
                console.error('❌ DOC ID non trovato nel testo:', textField);
                throw new TaggunApiError('Impossibile estrarre il Doc ID', 500, 'DOC_ID_ERR');
            }
            const docId = docIdMatch[1];
            console.log(`✅ DOC ID estratto: ${docId}`);
            // Inserisci il DOC ID nel campo entities.receiptNumber.data
            if (!response.data?.entities) {
                response.data.entities = {};
            }
            if (!response.data?.entities.receiptNumber) {
                response.data.entities.receiptNumber = {};
            }
            response.data.entities.receiptNumber.data = docId;
            return response.data;
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                const statusCode = error.response?.status;
                const errorMessage = error.response?.data?.errorMessage || error.message;
                console.error(`Errore Taggun API (${statusCode}):`, errorMessage);
                if (statusCode === 401) {
                    throw new Error('Autenticazione fallita: verificare la chiave API di Taggun');
                }
                else if (statusCode === 429) {
                    throw new Error('Limite di richieste superato: riprovare più tardi');
                }
                else if (statusCode === 413) {
                    throw new Error('File troppo grande: dimensione massima consentita 5MB');
                }
                else if (statusCode && statusCode >= 500) {
                    throw new Error('Errore del server Taggun: riprovare più tardi');
                }
                else {
                    throw new Error(`Errore elaborazione ricevuta: ${errorMessage}`);
                }
            }
            console.error('Errore imprevisto nel servizio Taggun:', error);
            throw new Error('Errore interno durante l\'elaborazione della ricevuta');
        }
    }
    async compressImage(imageBuffer, format) {
        try {
            let pipeline = sharp(imageBuffer);
            // Ridimensiona l'immagine mantenendo l'aspect ratio
            pipeline = pipeline.resize(2048, 2048, {
                fit: 'inside',
                withoutEnlargement: true,
            });
            // Comprimi in base al formato
            if (format.toLowerCase() === 'png') {
                return await pipeline
                    .png({ quality: 80, effort: 9 })
                    .toBuffer();
            }
            else {
                // JPEG
                return await pipeline
                    .jpeg({ quality: 80, progressive: true })
                    .toBuffer();
            }
        }
        catch (error) {
            console.error('Errore durante la compressione dell\'immagine:', error);
            throw error;
        }
    }
    getMimeType(filename) {
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
    async validateImageFile(imageBuffer, filename) {
        const maxSize = 20 * 1024 * 1024; // 20MB
        const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (imageBuffer.length > maxSize) {
            throw new Error('Dimensione file superiore a 20MB');
        }
        const mimeType = this.getMimeType(filename);
        if (!allowedTypes.includes(mimeType)) {
            throw new Error('Formato file non supportato. Usare JPG, PNG o PDF');
        }
    }
}
export const taggunService = new TaggunService();
//# sourceMappingURL=taggunService.js.map