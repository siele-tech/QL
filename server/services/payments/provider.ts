/**
 * Payment provider contract. Disbursement (B2C) and collection (STK push / C2B) are
 * asynchronous: the provider accepts the request, then confirms via callback.
 */
export interface PaymentRequest { phone: string; amount: number; reference: string; description: string }
export interface PaymentInitResult { accepted: boolean; providerReference?: string; error?: string }
export interface PaymentResult { providerReference: string; success: boolean; receiptNumber?: string; failureReason?: string }
export type PaymentResultHandler = (result: PaymentResult) => void;

export interface PaymentProvider {
  readonly name: string;
  disburse(req: PaymentRequest): Promise<PaymentInitResult>;
  collect(req: PaymentRequest): Promise<PaymentInitResult>;
  onResult(handler: PaymentResultHandler): void;
}
