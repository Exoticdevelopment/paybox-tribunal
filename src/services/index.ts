import type { AnyGuarantee } from "../kit/types.ts";
import { invoiceService } from "./invoice.ts";
import { summaryService } from "./summary.ts";
import { quoteService } from "./quote.ts";

/** Every guaranteed service this server offers. Add a new one here and it's live, priced and judged. */
export const services: AnyGuarantee[] = [invoiceService, summaryService, quoteService];
