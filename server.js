const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();

app.use(express.json({ limit: "10mb" }));

// Serve the main website folder
app.use(express.static(path.join(__dirname, "..")));

const PORT = process.env.PORT || 3000;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV = process.env.PAYPAL_ENV || "sandbox";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const PAYPAL_BASE_URL =
  PAYPAL_ENV === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const ORDERS_FILE = path.join(__dirname, "orders.json");


// ============================================================
// ORDER STORAGE
// ============================================================

function loadOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) {
      return [];
    }

    const data = fs.readFileSync(ORDERS_FILE, "utf8");

    if (!data.trim()) {
      return [];
    }

    return JSON.parse(data);
  } catch (error) {
    console.error("Could not load orders:", error);
    return [];
  }
}


function saveOrders(orders) {
  try {
    fs.writeFileSync(
      ORDERS_FILE,
      JSON.stringify(orders, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("Could not save orders:", error);
  }
}


// ============================================================
// PRICING
// ============================================================

function calculateMerchandiseTotal(quantity) {
  quantity = Number(quantity) || 0;

  if (quantity <= 0) {
    return 0;
  }

  let total = 0;

  const bundlesOf9 = Math.floor(quantity / 9);
  quantity %= 9;

  total += bundlesOf9 * 24;

  if (quantity >= 6) {
    total += 18;
    quantity -= 6;
  }

  if (quantity >= 3) {
    total += 9;
    quantity -= 3;
  }

  total += quantity * 3;

  return Number(total.toFixed(2));
}


// ============================================================
// PAYPAL
// ============================================================

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `PayPal authentication failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  return data.access_token;
}


// ============================================================
// ADMIN AUTHENTICATION
// ============================================================

function requireAdmin(req, res, next) {
  const password = req.headers["x-admin-password"];

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: "Admin password is not configured."
    });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Unauthorized."
    });
  }

  next();
}


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    environment: PAYPAL_ENV
  });
});


// ============================================================
// PAYPAL CONFIG FOR CHECKOUT
// ============================================================

app.get("/api/paypal-config", (req, res) => {
  if (!PAYPAL_CLIENT_ID) {
    return res.status(500).json({
      error: "PayPal Client ID is not configured."
    });
  }

  res.json({
    clientId: PAYPAL_CLIENT_ID,
    environment: PAYPAL_ENV
  });
});


// ============================================================
// CREATE PAYPAL ORDER
// ============================================================

app.post("/api/orders", async (req, res) => {
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return res.status(500).json({
        error: "PayPal credentials are not configured."
      });
    }

    const {
      items = [],
      customer = {},
      shipping = {},
      orderNotes = ""
    } = req.body;


    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Your cart is empty."
      });
    }


    // --------------------------------------------------------
    // Calculate total quantity
    // --------------------------------------------------------

    let totalQuantity = 0;

    for (const item of items) {
      const quantity = Number(item.quantity) || 0;

      if (quantity < 1) {
        return res.status(400).json({
          error: "Invalid item quantity."
        });
      }

      totalQuantity += quantity;
    }


    // --------------------------------------------------------
    // Calculate merchandise price on the server
    // --------------------------------------------------------

    const merchandiseTotal =
      calculateMerchandiseTotal(totalQuantity);

    const shippingTotal = 5;

    const total = Number(
      (merchandiseTotal + shippingTotal).toFixed(2)
    );


    // --------------------------------------------------------
    // Prepare clean order items for storage
    // --------------------------------------------------------

    const cleanItems = items.map(item => {
      const quantity = Number(item.quantity) || 1;

      return {
        id: item.id || null,
        type: item.type || "handmade",
        sku: item.sku || "",
        name: item.name || "Magnet",
        quantity: quantity,
        instructions: item.instructions || "",
        customerName: item.customerName || "",
        customerEmail: item.customerEmail || "",
        customerPhone: item.customerPhone || "",
        photos: Array.isArray(item.photos)
          ? item.photos
          : [],
        lineTotal: calculateMerchandiseTotal(quantity)
      };
    });


    // --------------------------------------------------------
    // Get PayPal access token
    // --------------------------------------------------------

    const accessToken = await getPayPalAccessToken();


    // --------------------------------------------------------
    // Create PayPal order
    // --------------------------------------------------------

    const paypalResponse = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          intent: "CAPTURE",

          purchase_units: [
            {
              amount: {
                currency_code: "USD",
                value: total.toFixed(2),
                breakdown: {
                  item_total: {
                    currency_code: "USD",
                    value: merchandiseTotal.toFixed(2)
                  },
                  shipping: {
                    currency_code: "USD",
                    value: shippingTotal.toFixed(2)
                  }
                }
              },

              description:
                "Tiny Memories Magnet Co. order"
            }
          ]
        })
      }
    );


    const paypalData = await paypalResponse.json();


    if (!paypalResponse.ok) {
      console.error(
        "PayPal create-order error:",
        JSON.stringify(paypalData, null, 2)
      );

      return res.status(500).json({
        error: "PayPal could not create the order."
      });
    }


    // --------------------------------------------------------
    // Save pending order
    // --------------------------------------------------------

    const orders = loadOrders();

    const savedOrder = {
      id:
        "order-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2, 8),

      createdAt: new Date().toISOString(),

      status: "PENDING",

      paypalOrderId: paypalData.id,

      customer: {
        firstName: customer.firstName || "",
        lastName: customer.lastName || "",
        email: customer.email || "",
        phone: customer.phone || ""
      },

      shipping: {
        address: shipping.address || "",
        address2: shipping.address2 || "",
        city: shipping.city || "",
        state: shipping.state || "",
        zip: shipping.zip || "",
        country: shipping.country || ""
      },

      orderNotes: orderNotes || "",

      items: cleanItems,

      totalQuantity: totalQuantity,

      merchandiseTotal: merchandiseTotal,

      shippingTotal: shippingTotal,

      total: total
    };


    orders.push(savedOrder);

    saveOrders(orders);


    // --------------------------------------------------------
    // Send PayPal order ID back to checkout
    // --------------------------------------------------------

    res.json({
      id: paypalData.id,
      total: total
    });

  } catch (error) {
    console.error("Create order error:", error);

    res.status(500).json({
      error: "Unable to create PayPal order."
    });
  }
});


// ============================================================
// CAPTURE PAYPAL ORDER
// ============================================================

app.post("/api/orders/:orderID/capture", async (req, res) => {
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return res.status(500).json({
        error: "PayPal credentials are not configured."
      });
    }

    const orderID = req.params.orderID;

    const accessToken = await getPayPalAccessToken();


    const paypalResponse = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        }
      }
    );


    const paypalData = await paypalResponse.json();


    if (!paypalResponse.ok) {
      console.error(
        "PayPal capture error:",
        JSON.stringify(paypalData, null, 2)
      );

      return res.status(500).json({
        error: "PayPal could not capture the payment.",
        details: paypalData
      });
    }


    // --------------------------------------------------------
    // Update saved order
    // --------------------------------------------------------

    const orders = loadOrders();

    const orderIndex = orders.findIndex(
      order => order.paypalOrderId === orderID
    );


    if (orderIndex !== -1) {
      orders[orderIndex].paypalCapture = paypalData;

      if (paypalData.status === "COMPLETED") {
        orders[orderIndex].status = "PAID";
        orders[orderIndex].paidAt =
          new Date().toISOString();
      }

      saveOrders(orders);
    }


    res.json(paypalData);

  } catch (error) {
    console.error("Capture order error:", error);

    res.status(500).json({
      error: "Unable to capture PayPal payment."
    });
  }
});


// ============================================================
// ADMIN ORDERS
// ============================================================

app.get(
  "/api/admin/orders",
  requireAdmin,
  (req, res) => {
    const orders = loadOrders();

    res.json(orders);
  }
);


// ============================================================
// SERVER START
// ============================================================

app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log(" Tiny Memories Magnet Co.");
  console.log(" Server is running!");
  console.log("========================================");
  console.log("");
  console.log(`Website: http://localhost:${PORT}`);
  console.log(`Checkout: http://localhost:${PORT}/checkout.html`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log("");
  console.log(`PayPal environment: ${PAYPAL_ENV}`);
  console.log("");
});