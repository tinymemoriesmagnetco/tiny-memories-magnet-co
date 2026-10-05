export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        environment: env.PAYPAL_ENV || "sandbox"
      });
    }

    if (url.pathname === "/api/paypal-config" && request.method === "GET") {
      if (!env.PAYPAL_CLIENT_ID) {
        return json(
          { error: "PayPal Client ID is not configured." },
          500
        );
      }

      return json({
        clientId: env.PAYPAL_CLIENT_ID,
        environment: env.PAYPAL_ENV || "sandbox"
      });
    }

    if (url.pathname === "/api/orders" && request.method === "POST") {
      return createOrder(request, env);
    }

    if (
      url.pathname.startsWith("/api/orders/") &&
      url.pathname.endsWith("/capture") &&
      request.method === "POST"
    ) {
      const parts = url.pathname.split("/");
      const orderID = decodeURIComponent(parts[3] || "");
      return captureOrder(orderID, env);
    }

    if (url.pathname === "/api/admin/orders" && request.method === "GET") {
      return getAdminOrders(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

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

function getPayPalBaseUrl(env) {
  return env.PAYPAL_ENV === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken(env) {
  const credentials =
    `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`;

  const auth = btoa(credentials);

  const response = await fetch(
    `${getPayPalBaseUrl(env)}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  if (!response.ok) {
    throw new Error("PayPal authentication failed.");
  }

  const data = await response.json();

  return data.access_token;
}

async function createOrder(request, env) {
  try {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      return json(
        { error: "PayPal credentials are not configured." },
        500
      );
    }

    const body = await request.json();

    const items = Array.isArray(body.cart)
      ? body.cart
      : Array.isArray(body.items)
        ? body.items
        : [];

    const customer = body.customer || {};
    const shipping = body.shipping || {};
    const orderNotes = body.orderNotes || "";

    if (items.length === 0) {
      return json({ error: "Your cart is empty." }, 400);
    }

    let totalQuantity = 0;

    for (const item of items) {
      const quantity = Number(item.quantity) || 0;

      if (quantity < 1) {
        return json(
          { error: "Invalid item quantity." },
          400
        );
      }

      totalQuantity += quantity;
    }

    const merchandiseTotal =
      calculateMerchandiseTotal(totalQuantity);

    const shippingTotal = 5;

    const total = Number(
      (merchandiseTotal + shippingTotal).toFixed(2)
    );

    const cleanItems = items.map(item => {
      const quantity = Number(item.quantity) || 1;

      return {
        id: item.id || null,
        type: item.type || "handmade",
        sku: item.sku || "",
        name: item.name || "Magnet",
        quantity,
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

    const accessToken =
      await getPayPalAccessToken(env);

    const paypalResponse = await fetch(
      `${getPayPalBaseUrl(env)}/v2/checkout/orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
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

    const paypalData =
      await paypalResponse.json();

    if (!paypalResponse.ok) {
      return json(
        { error: "PayPal could not create the order." },
        500
      );
    }

    const orderId =
      "order-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2, 8);

    await env.DB.prepare(`
      INSERT INTO orders (
        id,
        created_at,
        status,
        paypal_order_id,
        customer_json,
        shipping_json,
        order_notes,
        items_json,
        total_quantity,
        merchandise_total,
        shipping_total,
        total,
        paypal_capture_json,
        paid_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        orderId,
        new Date().toISOString(),
        "PENDING",
        paypalData.id,
        JSON.stringify({
          firstName: customer.firstName || "",
          lastName: customer.lastName || "",
          email: customer.email || "",
          phone: customer.phone || ""
        }),
        JSON.stringify({
          address: shipping.address || "",
          address2: shipping.address2 || "",
          city: shipping.city || "",
          state: shipping.state || "",
          zip: shipping.zip || "",
          country: shipping.country || ""
        }),
        orderNotes,
        JSON.stringify(cleanItems),
        totalQuantity,
        merchandiseTotal,
        shippingTotal,
        total,
        null,
        null
      )
      .run();

    return json({
      id: paypalData.id,
      total
    });
  } catch (error) {
    console.error("Create order error:", error);

    return json(
      { error: "Unable to create PayPal order." },
      500
    );
  }
}

async function captureOrder(orderID, env) {
  try {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      return json(
        { error: "PayPal credentials are not configured." },
        500
      );
    }

    const accessToken =
      await getPayPalAccessToken(env);

    const paypalResponse = await fetch(
      `${getPayPalBaseUrl(env)}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const paypalData =
      await paypalResponse.json();

    if (!paypalResponse.ok) {
      return json(
        {
          error: "PayPal could not capture the payment.",
          details: paypalData
        },
        500
      );
    }

    const status =
      paypalData.status === "COMPLETED"
        ? "PAID"
        : "PENDING";

    const paidAt =
      paypalData.status === "COMPLETED"
        ? new Date().toISOString()
        : null;

    await env.DB.prepare(`
      UPDATE orders
      SET
        status = ?,
        paypal_capture_json = ?,
        paid_at = ?
      WHERE paypal_order_id = ?
    `)
      .bind(
        status,
        JSON.stringify(paypalData),
        paidAt,
        orderID
      )
      .run();

    return json({
      success: paypalData.status === "COMPLETED",
      status: paypalData.status,
      paypal: paypalData
    });
  } catch (error) {
    console.error("Capture order error:", error);

    return json(
      { error: "Unable to capture PayPal order." },
      500
    );
  }
}

async function getAdminOrders(request, env) {
  const password =
    request.headers.get("x-admin-password");

  if (!env.ADMIN_PASSWORD) {
    return json(
      { error: "Admin password is not configured." },
      500
    );
  }

  if (password !== env.ADMIN_PASSWORD) {
    return json(
      { error: "Unauthorized." },
      401
    );
  }

  try {
    const result = await env.DB.prepare(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `).all();

    const orders = (result.results || []).map(row => ({
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      paypalOrderId: row.paypal_order_id,
      customer: JSON.parse(row.customer_json || "{}"),
      shipping: JSON.parse(row.shipping_json || "{}"),
      orderNotes: row.order_notes || "",
      items: JSON.parse(row.items_json || "[]"),
      totalQuantity: row.total_quantity,
      merchandiseTotal: row.merchandise_total,
      shippingTotal: row.shipping_total,
      total: row.total,
      paypalCapture: row.paypal_capture_json
        ? JSON.parse(row.paypal_capture_json)
        : null,
      paidAt: row.paid_at || null
    }));

    return json(orders);
  } catch (error) {
    console.error("Admin orders error:", error);

    return json(
      { error: "Unable to load orders." },
      500
    );
  }
}
