
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/api/health" && method === "GET") {
      return json({
        ok: true,
        environment: env.PAYPAL_ENV || "sandbox"
      });
    }

    if (path === "/api/paypal-config" && method === "GET") {
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

    // Website page-view tracking.
    if (path === "/api/track-view" && method === "POST") {
      return trackPageView(request, env);
    }

    // Existing PayPal order endpoints.
    if (path === "/api/orders" && method === "POST") {
      return createOrder(request, env);
    }

    const captureMatch = path.match(
      /^\/api\/orders\/([^/]+)\/capture$/
    );

    if (captureMatch && method === "POST") {
      return captureOrder(
        decodeURIComponent(captureMatch[1]),
        env
      );
    }

    // Admin order list.
    if (path === "/api/admin/orders" && method === "GET") {
      return getAdminOrders(request, env);
    }

    // Admin dashboard statistics.
    if (path === "/api/admin/stats" && method === "GET") {
      return getAdminStats(request, env);
    }

    // Mark a paid order as shipped.
    const shipMatch = path.match(
      /^\/api\/admin\/orders\/([^/]+)\/ship$/
    );

    if (shipMatch && method === "POST") {
      return updateFulfillment(
        request,
        env,
        decodeURIComponent(shipMatch[1]),
        "ship"
      );
    }

    // Archive a shipped order.
    const archiveMatch = path.match(
      /^\/api\/admin\/orders\/([^/]+)\/archive$/
    );

    if (archiveMatch && method === "POST") {
      return updateFulfillment(
        request,
        env,
        decodeURIComponent(archiveMatch[1]),
        "archive"
      );
    }

    // Restore an archived order.
    const restoreMatch = path.match(
      /^\/api\/admin\/orders\/([^/]+)\/restore$/
    );

    if (restoreMatch && method === "POST") {
      return updateFulfillment(
        request,
        env,
        decodeURIComponent(restoreMatch[1]),
        "restore"
      );
    }

    // Never serve unknown API paths as website files.
    if (path.startsWith("/api/")) {
      return json({ error: "API endpoint not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function calculateMerchandiseTotal(quantity) {
  quantity = Number(quantity) || 0;

  if (quantity <= 0) return 0;

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

function validQuantity(value, max = 500) {
  const number = Number(value);

  return Number.isSafeInteger(number) &&
    number >= 1 &&
    number <= max
      ? number
      : null;
}

function priceCart(items) {
  let handmadeQuantity = 0;
  let customPhotoTotal = 0;
  let specialtyTotal = 0;
  let totalQuantity = 0;

  const cleanItems = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new Error("Invalid cart item.");
    }

    const quantity = validQuantity(item.quantity);

    if (!quantity) {
      throw new Error("Invalid item quantity.");
    }

    const sku = String(item.sku || "")
      .trim()
      .toUpperCase();

    const type = String(item.type || "handmade")
      .toLowerCase();

    const clean = {
      id: String(item.id || "").slice(0, 150),
      type,
      sku,
      name: String(item.name || "Magnet").slice(0, 200),
      quantity,
      instructions: String(item.instructions || "")
        .slice(0, 3000),
      customerName: String(item.customerName || "")
        .slice(0, 200),
      customerEmail: String(item.customerEmail || "")
        .slice(0, 200),
      customerPhone: String(item.customerPhone || "")
        .slice(0, 100),
      photos: Array.isArray(item.photos)
        ? item.photos
        : []
    };

    if (sku === "SPECIAL-WESTERN") {
      clean.type = "specialty";
      clean.lineTotal = quantity * 20;
      specialtyTotal += clean.lineTotal;

    } else if (sku === "SPECIAL-ALPHABET") {
      clean.type = "specialty";
      clean.lineTotal = quantity * 120;
      specialtyTotal += clean.lineTotal;

    } else if (sku === "SPECIAL-CUSTOM-NAME") {
      const magnetCount = validQuantity(
        item.magnetCount,
        9
      );

      if (![1, 3, 6, 9].includes(magnetCount)) {
        throw new Error(
          "Invalid personalized magnet bundle size."
        );
      }

      clean.type = "specialty";
      clean.magnetCount = magnetCount;

      clean.customName = String(
        item.customName ||
        item.personalizedName ||
        item.nameText ||
        ""
      ).slice(0, 200);

      clean.color = String(
        item.color ||
        item.selectedColor ||
        ""
      ).slice(0, 100);

      clean.lineTotal =
        quantity * calculateMerchandiseTotal(magnetCount);

      specialtyTotal += clean.lineTotal;

    } else if (
      type === "custom" &&
      sku === "CUSTOM-PHOTO"
    ) {
      clean.lineTotal =
        calculateMerchandiseTotal(quantity);

      customPhotoTotal += clean.lineTotal;

    } else if (
      type === "handmade" &&
      /^MAG-[A-Z0-9-]+$/.test(sku)
    ) {
      handmadeQuantity += quantity;
      clean.lineTotal = quantity * 3;

    } else {
      throw new Error(
        "Unrecognized product in cart: " + sku
      );
    }

    totalQuantity += quantity;
    cleanItems.push(clean);
  }

  const merchandiseTotal =
    calculateMerchandiseTotal(handmadeQuantity) +
    customPhotoTotal +
    specialtyTotal;

  return {
    cleanItems,
    totalQuantity,
    merchandiseTotal:
      Number(merchandiseTotal.toFixed(2))
  };
}

function getPayPalBaseUrl(env) {
  return env.PAYPAL_ENV === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken(env) {
  const credentials =
    `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`;

  const response = await fetch(
    `${getPayPalBaseUrl(env)}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(credentials)}`,
        "Content-Type":
          "application/x-www-form-urlencoded"
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
    if (
      !env.PAYPAL_CLIENT_ID ||
      !env.PAYPAL_CLIENT_SECRET
    ) {
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
      return json(
        { error: "Your cart is empty." },
        400
      );
    }

    let priced;

    try {
      priced = priceCart(items);
    } catch (error) {
      return json({ error: error.message }, 400);
    }

    const {
      cleanItems,
      totalQuantity,
      merchandiseTotal
    } = priced;

    const shippingTotal = 5;

    const total = Number(
      (merchandiseTotal + shippingTotal).toFixed(2)
    );

    const accessToken = await getPayPalAccessToken(env);

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

    const paypalData = await paypalResponse.json();

    if (!paypalResponse.ok || !paypalData.id) {
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
        String(orderNotes).slice(0, 3000),
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
    if (
      !env.PAYPAL_CLIENT_ID ||
      !env.PAYPAL_CLIENT_SECRET
    ) {
      return json(
        { error: "PayPal credentials are not configured." },
        500
      );
    }

    // Only capture orders that belong to this store.
    const existingOrder = await env.DB.prepare(`
      SELECT id, status
      FROM orders
      WHERE paypal_order_id = ?
      LIMIT 1
    `).bind(orderID).first();

    if (!existingOrder) {
      return json({ error: "Order not found." }, 404);
    }

    if (existingOrder.status === "PAID") {
      return json({
        success: true,
        status: "COMPLETED"
      });
    }

    const accessToken = await getPayPalAccessToken(env);

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

    const paypalData = await paypalResponse.json();

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

// Admin authentication is required for every admin API.
function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;

  const supplied =
    request.headers.get("x-admin-password") || "";

  return supplied === env.ADMIN_PASSWORD;
}

function adminError(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return json(
      { error: "Admin password is not configured." },
      500
    );
  }

  if (!isAdmin(request, env)) {
    return json({ error: "Unauthorized." }, 401);
  }

  return null;
}

// Store anonymous page-view counts.
// This does not collect visitor names, emails or IP addresses.
async function trackPageView(request, env) {
  try {
    const origin = request.headers.get("Origin");

    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: "Invalid origin." }, 403);
    }

    const body = await request.json();

    let page = String(body.page || "")
      .trim()
      .split("?")[0]
      .split("#")[0];

    if (!page.startsWith("/")) {
      return json({ error: "Invalid page." }, 400);
    }

    if (page.length > 200) {
      return json({ error: "Invalid page." }, 400);
    }

    if (
      page.startsWith("/api/") ||
      page === "/admin.html" ||
      page.includes("..")
    ) {
      return json({ error: "Page not tracked." }, 400);
    }

    if (page === "/") {
      page = "/index.html";
    }

    // Count page views by UTC date and page.
    const day = new Date().toISOString().slice(0, 10);

    await env.DB.prepare(`
      INSERT INTO page_views (day, page, views)
      VALUES (?, ?, 1)
      ON CONFLICT(day, page)
      DO UPDATE SET views = views + 1
    `).bind(day, page).run();

    return json({ success: true });

  } catch (error) {
    console.error("Page view tracking error:", error);

    return json(
      { error: "Could not record page view." },
      500
    );
  }
}

async function getAdminStats(request, env) {
  const authError = adminError(request, env);
  if (authError) return authError;

  try {
    const today = new Date().toISOString().slice(0, 10);

    const views = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(views), 0) AS total_views,
        COALESCE(
          SUM(CASE WHEN day = ? THEN views ELSE 0 END),
          0
        ) AS today_views
      FROM page_views
    `).bind(today).first();

    const orders = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total_orders,
        COALESCE(
          SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END),
          0
        ) AS paid_orders,
        COALESCE(
          SUM(CASE WHEN status = 'PAID' THEN total ELSE 0 END),
          0
        ) AS total_sales
      FROM orders
    `).first();

    return json({
      totalViews: Number(views?.total_views || 0),
      todayViews: Number(views?.today_views || 0),
      totalOrders: Number(orders?.total_orders || 0),
      paidOrders: Number(orders?.paid_orders || 0),
      totalSales: Number(orders?.total_sales || 0),
      timezone: "UTC"
    });

  } catch (error) {
    console.error("Admin stats error:", error);

    return json(
      { error: "Unable to load statistics." },
      500
    );
  }
}

async function getAdminOrders(request, env) {
  const authError = adminError(request, env);
  if (authError) return authError;

  try {
    const result = await env.DB.prepare(`
      SELECT
        o.*,
        f.shipped_at AS fulfillment_shipped_at,
        f.archived_at AS fulfillment_archived_at
      FROM orders o
      LEFT JOIN order_fulfillment f
        ON f.order_id = o.id
      ORDER BY o.created_at DESC
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
      paidAt: row.paid_at || null,
      shippedAt: row.fulfillment_shipped_at || null,
      archivedAt: row.fulfillment_archived_at || null,
      fulfillmentStatus: row.fulfillment_archived_at
        ? "ARCHIVED"
        : row.fulfillment_shipped_at
          ? "SHIPPED"
          : "ACTIVE"
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

async function updateFulfillment(
  request,
  env,
  orderId,
  action
) {
  const authError = adminError(request, env);
  if (authError) return authError;

  if (!orderId || orderId.length > 150) {
    return json({ error: "Invalid order ID." }, 400);
  }

  try {
    const order = await env.DB.prepare(`
      SELECT
        o.id,
        o.status,
        f.shipped_at,
        f.archived_at
      FROM orders o
      LEFT JOIN order_fulfillment f
        ON f.order_id = o.id
      WHERE o.id = ?
      LIMIT 1
    `).bind(orderId).first();

    if (!order) {
      return json({ error: "Order not found." }, 404);
    }

    if (order.status !== "PAID") {
      return json(
        {
          error:
            "Only paid orders can be marked as shipped or archived."
        },
        400
      );
    }

    const now = new Date().toISOString();

    if (action === "ship") {
      if (order.archived_at) {
        return json(
          { error: "Restore this order before updating it." },
          400
        );
      }

      if (order.shipped_at) {
        return json({
          success: true,
          fulfillmentStatus: "SHIPPED",
          shippedAt: order.shipped_at
        });
      }

      await env.DB.prepare(`
        INSERT INTO order_fulfillment (
          order_id, shipped_at, archived_at
        )
        SELECT id, ?, NULL
        FROM orders
        WHERE id = ? AND status = 'PAID'
        ON CONFLICT(order_id)
        DO UPDATE SET
          shipped_at = COALESCE(
            order_fulfillment.shipped_at,
            excluded.shipped_at
          )
      `).bind(now, orderId).run();

      return json({
        success: true,
        fulfillmentStatus: "SHIPPED",
        shippedAt: now
      });
    }

    if (action === "archive") {
      if (!order.shipped_at) {
        return json(
          { error: "Mark this order as shipped first." },
          400
        );
      }

      if (order.archived_at) {
        return json({
          success: true,
          fulfillmentStatus: "ARCHIVED",
          archivedAt: order.archived_at
        });
      }

      await env.DB.prepare(`
        UPDATE order_fulfillment
        SET archived_at = ?
        WHERE order_id = ?
          AND shipped_at IS NOT NULL
          AND archived_at IS NULL
      `).bind(now, orderId).run();

      return json({
        success: true,
        fulfillmentStatus: "ARCHIVED",
        archivedAt: now
      });
    }

    if (action === "restore") {
      if (!order.archived_at) {
        return json({
          success: true,
          fulfillmentStatus: order.shipped_at
            ? "SHIPPED"
            : "ACTIVE"
        });
      }

      await env.DB.prepare(`
        UPDATE order_fulfillment
        SET archived_at = NULL
        WHERE order_id = ?
      `).bind(orderId).run();

      return json({
        success: true,
        fulfillmentStatus: "SHIPPED"
      });
    }

    return json({ error: "Invalid action." }, 400);

  } catch (error) {
    console.error("Fulfillment update error:", error);

    return json(
      { error: "Unable to update order." },
      500
    );
  }
}
