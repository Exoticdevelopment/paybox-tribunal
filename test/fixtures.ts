export const GOOD_INVOICE = `
Vendor: Panadería La Esquina
Invoice: FE-2026-0412
Date: 2026-10-14
Currency: COP

2 x Pan de bono @ 2500 = 5000
3 x Café tinto @ 1800 = 5400
1 x Torta de chocolate @ 32000 = 32000

Subtotal: 42400
Tax: 8056
Total: 50456
`;

export const VALID_OUTPUT = {
  vendor_name: "Panadería La Esquina",
  invoice_number: "FE-2026-0412",
  issue_date: "2026-10-14",
  currency: "COP",
  line_items: [
    { description: "Pan de bono", quantity: 2, unit_price: 2500, amount: 5000 },
    { description: "Café tinto", quantity: 3, unit_price: 1800, amount: 5400 },
    { description: "Torta de chocolate", quantity: 1, unit_price: 32000, amount: 32000 },
  ],
  subtotal: 42400,
  tax: 8056,
  total: 50456,
};

export const ARTICLE = `PayBox is a non-custodial payment vault launched by MoonPay in July 2026. It lets people store wallets, cards and secrets once and then authorise AI agents to pay within limits they set. Sensitive actions require passkey approval. Agents never receive raw credentials; they get scoped outputs such as single-use virtual cards. PayBox supports x402, so agents can pay for web services per request. At launch it worked with 2 assistants, Claude and ChatGPT.`;
