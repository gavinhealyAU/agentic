import express from 'express';
import fs from 'fs';
import dotenv from 'dotenv';
import cors from 'cors';
import OpenAI from 'openai';
import axios from 'axios';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const products = JSON.parse(fs.readFileSync('data/products.json'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function createInvoiceOrder(product) {
  const auth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');

  const response = await axios.post(
    `${process.env.PAYPAL_API || 'https://api-m.sandbox.paypal.com'}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: product.price.toFixed(2),
            breakdown: {
              item_total: {
                currency_code: 'USD',
                value: product.price.toFixed(2)
              }
            }
          },
          description: product.name,
          items: [
            {
              name: product.name,
              unit_amount: {
                currency_code: 'USD',
                value: product.price.toFixed(2)
              },
              quantity: '1',
              category: 'PHYSICAL_GOODS'
            }
          ]
        }
      ],
      application_context: {
        return_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel'
      }
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    }
  );

  return response.data;
}

async function createAndCaptureOrder(product) {
  const auth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');

  const tokenRes = await axios.post(
    `${process.env.PAYPAL_API}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  const accessToken = tokenRes.data.access_token;

  const orderRes = await axios.post(
    `${process.env.PAYPAL_API}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: product.price.toFixed(2)
          },
          description: product.name
        }
      ],
      payment_source: {
        token: {
          id: process.env.PAYPAL_VAULTED_PAYMENT_TOKEN,
          type: 'BILLING_AGREEMENT'
        }
      }
    },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const order = orderRes.data;

  if (order.status === 'COMPLETED') {
    return order;
  }

  const captureRes = await axios.post(
    `${process.env.PAYPAL_API}/v2/checkout/orders/${order.id}/capture`,
    {},
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return captureRes.data;
}

async function refundTransaction(captureId) {
  const auth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');

  const tokenRes = await axios.post(
    `${process.env.PAYPAL_API}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  const accessToken = tokenRes.data.access_token;

  const refundRes = await axios.post(
    `${process.env.PAYPAL_API}/v2/payments/captures/${captureId}/refund`,
    {},
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return refundRes.data;
}

async function fetchUserTransactions() {
  const auth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');

  const tokenRes = await axios.post(
    `${process.env.PAYPAL_API}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  const accessToken = tokenRes.data.access_token;

  const now = new Date();
  const past = new Date(now);
  past.setMonth(past.getMonth() - 1);

  const start_date = past.toISOString().split('.')[0] + 'Z';
  const end_date = now.toISOString().split('.')[0] + 'Z';

  const txRes = await axios.get(
    `${process.env.PAYPAL_API}/v1/reporting/transactions`,
    {
      params: {
        start_date,
        end_date,
        fields: 'all',
        page_size: 10
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return txRes.data.transaction_details.map(t => {
    const item = t.transaction_info;
    const matchedProduct = products.find(p =>
      parseFloat(p.price).toFixed(2) === parseFloat(item.transaction_amount?.value).toFixed(2)
    );

    return {
      transaction_id: item.transaction_id,
      status: item.transaction_status,
      gross: item.transaction_amount?.value,
      currency: item.transaction_amount?.currency_code,
      timestamp: item.transaction_initiation_date,
      product_name: matchedProduct?.name || 'Unknown Item'
    };
  });
}
app.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    const tools = [
      {
        type: "function",
        function: {
          name: "refund_transaction",
          description: "Processes a refund for a PayPal transaction using the capture ID.",
          parameters: {
            type: "object",
            properties: {
              capture_id: { type: "string" }
            },
            required: ["capture_id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_and_capture_order",
          description: "Captures a PayPal order immediately using saved (vaulted) payment information.",
          parameters: {
            type: "object",
            properties: {
              product: { type: "string" },
              price: { type: "number" },
              payment_method: { type: "string", enum: ["vaulted"] }
            },
            required: ["product", "price", "payment_method"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_invoice_order",
          description: "Creates a PayPal order and returns an approval link, simulating an invoice.",
          parameters: {
            type: "object",
            properties: {
              product: { type: "string" },
              price: { type: "number" }
            },
            required: ["product", "price"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fetch_user_transactions",
          description: "Returns the last few PayPal transactions for the sandbox user.",
          parameters: {
            type: "object",
            properties: {}
          },
          required: []
        }
      }
    ];

    const productList = products.map(p => `${p.name} - $${p.price} - ${p.image}`).join('\n');

    const messages = [
      {
        role: "system",
        content: `You are a helpful shopping assistant. ONLY recommend products from the list below. Do NOT invent new products.

You already know the user's PayPal account is sb-yghbo43203573@personal.example.com. Do not ask them for it.

Always explain why you're recommending the product based on the user's need. Then show the product in HTML format using this structure:

<div class="product">
  <img src="[IMAGE_URL]" alt="[PRODUCT_NAME]" />
  <div class="info">
    <h4>[PRODUCT_NAME]</h4>
    <p>Price: $[PRICE]</p>
  </div>
</div>

After showing a product, always ask: “Would you like to buy this?”

If the user says yes, ask: “Would you like to pay now with your saved PayPal account, or receive a PayPal link to pay now?”

Here are the ONLY products you may offer:\n${productList}`
      },
      ...history,
      { role: "user", content: message }
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools,
      tool_choice: "auto"
    });

    const choice = response.choices[0];

    if (choice.finish_reason === 'tool_calls') {
      const toolCall = choice.message.tool_calls?.[0];
      const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : null;

      if (toolCall.function.name === 'fetch_user_transactions') {
        const tx = await fetchUserTransactions();
        if (!tx || tx.length === 0) {
          return res.json({ reply: `📋 No recent transactions found.` });
        }

        const formatted = tx.map(t => {
          const date = new Date(t.timestamp).toLocaleString("en-AU", {
            dateStyle: "medium",
            timeStyle: "short"
          });
          return `🧾 <strong>${date}</strong><br>ID: ${t.transaction_id}<br>Product: ${t.product_name}<br>Status: ${t.status}<br>Amount: $${t.gross} ${t.currency}<br><br>`;
        }).join('');

        return res.json({ reply: `📋 <strong>Recent Transactions:</strong><br><br>${formatted}` });
      }

      if (toolCall.function.name === 'refund_transaction') {
        const refund = await refundTransaction(args.capture_id);
        return res.json({ reply: `Really sorry to hear that. I've checke this, and we have refunded the full transaction amount for Order ID ${args.capture_id}. Refund ID: ${refund.id}` });
      }

      const match = args ? products.find(p => p.name.toLowerCase() === args.product.toLowerCase()) : null;
      if (!match) {
        return res.json({ reply: `❌ Sorry, I couldn’t find the product "${args?.product}".` });
      }

      try {
        if (toolCall.function.name === 'create_and_capture_order') {
          const result = await createAndCaptureOrder(match);
          return res.json({
            reply: `✅ Payment successful! You bought the ${match.name}. Transaction ID: ${result.purchase_units?.[0]?.payments?.captures?.[0]?.id || 'N/A'}.`
          });
        } else if (toolCall.function.name === 'create_invoice_order') {
          const order = await createInvoiceOrder(match);
          const link = order.links.find(l => l.rel === 'approve')?.href;
          return res.json({ 
            reply: `🧾 Please complete your purchase by clicking this PayPal button:<br><br><a href="${link}" target="_blank"><img src="/paypal.png" alt="Pay with PayPal" style="height:50px"/></a>` 
          });
        } else {
          return res.json({ reply: `❌ Unknown function request.` });
        }
      } catch (paypalErr) {
        console.error("PayPal error:", paypalErr);
        return res.json({ reply: `❌ There was an issue processing the payment. Please try again.` });
      }
    }

    const replyText = choice.message?.content || "❌ I didn’t receive a proper response.";
    res.json({ reply: replyText });
  } catch (error) {
    console.error("Error in /chat:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(3000, () => console.log("✅ Server running at http://localhost:3000"));
