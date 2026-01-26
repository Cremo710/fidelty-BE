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
export declare class TaggunService {
    private apiKey;
    private apiUrl;
    constructor();
    processReceipt(imageBuffer: Buffer, filename: string): Promise<TaggunResponse>;
    private compressImage;
    private getMimeType;
    validateImageFile(imageBuffer: Buffer, filename: string): Promise<void>;
}
export declare const taggunService: TaggunService;
