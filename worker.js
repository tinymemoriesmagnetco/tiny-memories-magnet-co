
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

    // EMAIL MARKETING
    if (path === "/api/subscribe" && method === "POST") {
      return subscribeToEmails(request, env);
    }

    if (path === "/api/unsubscribe" && method === "GET") {
      return unsubscribeFromEmails(request, env);
    }

    // WEBSITE TRACKING
    if (path === "/api/track-view" && method === "POST") {
      return trackPageView(request, env);
    }

    // DISCOUNT VALIDATION
    if (
      path === "/api/discount/validate" &&
      method === "POST"
    ) {
      return validateDiscount(request, env);
    }

    if (path === "/api/save-date-request" && method === "POST") {
      return submitSaveDateRequest(request, env);
    }

    // PAYPAL
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

    // ADMIN
    if (path === "/api/admin/orders" && method === "GET") {
      return getAdminOrders(request, env);
    }

    if (path === "/api/admin/subscribers" && method === "GET") {
      return getAdminSubscribers(request, env);
    }

    if (path === "/api/admin/stats" && method === "GET") {
      return getAdminStats(request, env);
    }

    const fulfillmentMatch = path.match(
      /^\/api\/admin\/orders\/([^/]+)\/(ship|archive|restore)$/
    );

    if (fulfillmentMatch && method === "POST") {
      return updateFulfillment(
        request,
        env,
        decodeURIComponent(fulfillmentMatch[1]),
        fulfillmentMatch[2]
      );
    }

    // ADMIN: delete an unpaid, unapproved order only after checking PayPal.
    const deleteOrderMatch = path.match(
      /^\/api\/admin\/orders\/([^/]+)\/delete$/
    );

    if (deleteOrderMatch && method === "POST") {
      return deleteUnpaidOrder(
        request,
        env,
        decodeURIComponent(deleteOrderMatch[1])
      );
    }

    // VENDOR MARKET: separate from PayPal and shipping checkout.
    if (path === "/api/vendor-orders" && method === "POST") return submitVendorOrder(request, env);
    if (path === "/api/admin/vendor-orders" && method === "GET") return listVendorOrders(request, env);
    const vendorPhoto = path.match(/^\/api\/admin\/vendor-orders\/([^/]+)\/photos\/(\d+)$/);
    if (vendorPhoto && method === "GET") return getVendorPhoto(request, env, vendorPhoto[1], Number(vendorPhoto[2]));
    const vendorStatus = path.match(/^\/api\/admin\/vendor-orders\/([^/]+)\/status$/);
    if (vendorStatus && method === "POST") return setVendorStatus(request, env, vendorStatus[1]);

    if (path.startsWith("/api/")) {
      return json({ error: "API endpoint not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};

// ============================================
// RESPONSE HELPERS
// ============================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function validQuantity(value, max = 500) {
  const number = Number(value);

  return Number.isSafeInteger(number) &&
    number >= 1 &&
    number <= max
      ? number
      : null;
}

// ============================================
// PRODUCT PRICING
// ============================================

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

function priceCart(items) {
  let handmadeQuantity = 0;
  let customPhotoTotal = 0;
  let specialtyTotal = 0;
  let saveDateTotal = 0;
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

    if (sku === "SAVE-DATE-SET") {
      const tiers = {50:125,75:172.5,100:200,150:270,200:320};
      if (!Object.prototype.hasOwnProperty.call(tiers, quantity)) {
        throw new Error("Choose an available Save the Date quantity.");
      }
      const details = item.saveDateDetails || {};
      const names = String(details.names || "").trim().slice(0,200);
      const date = String(details.date || "").trim().slice(0,100);
      const colors = String(details.colors || "").trim().slice(0,500);
      const design = String(details.design || "").trim().slice(0,100);
      const ideas = String(details.ideas || "").trim().slice(0,2000);
      const wording = String(details.wording || "").trim().slice(0,1000);
      if (!names || !date || !design) throw new Error("Save the Date details are incomplete.");
      if (details.envelopes !== "no") throw new Error("Envelope quotes must be requested before paying.");
      if (!Array.isArray(item.photos) || item.photos.length !== 1 ||
          !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(item.photos[0]?.dataUrl || "")) ||
          String(item.photos[0].dataUrl).length > 450000) {
        throw new Error("Please upload a valid Save the Date photo under 330 KB compressed.");
      }
      clean.type = "save-date";
      clean.saveDateDetails = {names,date,colors,design,ideas,wording,envelopes:"no"};
      clean.photos = [{name:"save-the-date-photo.jpg",dataUrl:item.photos[0].dataUrl}];
      clean.lineTotal = tiers[quantity];
      saveDateTotal += clean.lineTotal;
    } else if (sku === "SPECIAL-WESTERN") {
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
      (type === "handmade" || type === "seasonal" || sku.startsWith("SEA-")) &&
      /^(?:MAG|SEA)-[A-Z0-9-]+$/.test(sku)
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
    specialtyTotal +
    saveDateTotal;

  return {
    cleanItems,
    totalQuantity,
    merchandiseTotal:
      Number(merchandiseTotal.toFixed(2))
  };
}

// Save the Date shipping tiers. Regular orders remain $5.
// For mixed carts or multiple Save the Date sets, use the highest tier,
// matching the checkout page's displayed shipping calculation.
const SAVE_DATE_SHIPPING = {50:10,75:12,100:15,150:18,200:22};

function calculateShipping(items) {
  const saveDateRates = items
    .filter(item => String(item.sku || "").trim().toUpperCase() === "SAVE-DATE-SET")
    .map(item => SAVE_DATE_SHIPPING[Number(item.quantity)]);
  if (saveDateRates.some(rate => !Number.isFinite(rate))) {
    throw new Error("Invalid Save the Date shipping quantity.");
  }
  return saveDateRates.length ? Math.max(...saveDateRates) : 5;
}

// ============================================
// PAYPAL AUTHENTICATION
// ============================================

function getPayPalBaseUrl(env) {
  return ["live", "production"].includes(
    String(env.PAYPAL_ENV || "").trim().toLowerCase()
  )
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
  const errorData = await response.json().catch(() => ({}));

  console.error("PayPal authentication error:", {
    status: response.status,
    error: errorData.error || "unknown",
    description: errorData.error_description || ""
  });

  throw new Error("PayPal authentication failed.");
}

  const data = await response.json();
  return data.access_token;
}

// ============================================
// CREATE PAYPAL ORDER
// ============================================

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
      return json({ error: "Your cart is empty." }, 400);
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

    // Shipping is calculated server-side to match checkout.
    const shippingTotal = calculateShipping(items);

 
    // Apply TINY10 to eligible first-time customers.
    const requestedDiscountCode = String(
      body.discountCode || ""
    ).trim().toUpperCase();

    let discountCode = "";
    let discountAmount = 0;

    if (requestedDiscountCode) {
      if (requestedDiscountCode !== "TINY10") {
        return json(
          { error: "Invalid discount code." },
          400
        );
      }

      try {
        discountAmount = await calculateTiny10Discount(
          env,
          customer.email,
          merchandiseTotal
        );

        discountCode = "TINY10";
      } catch (error) {
        return json(
          { error: error.message },
          400
        );
      }
    }

    const total = Number(
      (
        merchandiseTotal +
        shippingTotal -
        discountAmount
      ).toFixed(2)
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
                  },
                  ...(discountAmount > 0
                    ? {
                        discount: {
                          currency_code: "USD",
                          value: discountAmount.toFixed(2)
                        }
                      }
                    : {})

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
        discount_code,
        discount_amount,
        paypal_capture_json,
        paid_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        discountCode || null,
        discountAmount,
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

// A reservation may be released ONLY after PayPal confirms its order is VOIDED.
// Unknown/network-error states stay reserved to avoid a second discounted capture.
async function findActiveTiny10Claim(env, email) {
  const claim = await env.DB.prepare(`
    SELECT paypal_order_id, redeemed_at
    FROM discount_redemptions
    WHERE LOWER(TRIM(email)) = ? AND UPPER(TRIM(discount_code)) = 'TINY10'
    LIMIT 1
  `).bind(email).first();
  if (!claim) return null;

  // Completed discounts must never be released, including legacy records.
  const owner = await env.DB.prepare(`
    SELECT status FROM orders WHERE paypal_order_id = ? LIMIT 1
  `).bind(claim.paypal_order_id).first();
  if (!owner || owner.status === 'PAID') return claim;

  // Do not mistake a capture timeout for a failed payment.
  // Only PayPal's explicit VOIDED state authorizes releasing a reservation.
  try {
    const token = await getPayPalAccessToken(env);
    const response = await fetch(
      `${getPayPalBaseUrl(env)}/v2/checkout/orders/${encodeURIComponent(claim.paypal_order_id)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) return claim;
    const paypalOrder = await response.json();
    if (paypalOrder.status !== 'VOIDED') return claim;

    // Conditional delete avoids removing a paid redemption if another
    // request has updated the local order while this check was in flight.
    await env.DB.prepare(`
      DELETE FROM discount_redemptions
      WHERE LOWER(TRIM(email)) = ?
        AND UPPER(TRIM(discount_code)) = 'TINY10'
        AND paypal_order_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM orders
          WHERE paypal_order_id = ? AND status = 'PAID'
        )
    `).bind(email, claim.paypal_order_id, claim.paypal_order_id).run();
    return await env.DB.prepare(`
      SELECT paypal_order_id FROM discount_redemptions
      WHERE LOWER(TRIM(email)) = ? AND UPPER(TRIM(discount_code)) = 'TINY10'
      LIMIT 1
    `).bind(email).first();
  } catch (error) {
    console.error('TINY10 reservation reconciliation failed:', error);
    return claim;
  }
}

// ============================================
// CAPTURE PAYPAL PAYMENT
// ============================================

async function captureOrder(orderID, env) {
  try {
    if (!env.DB || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      return json({ error: "Payment configuration is unavailable." }, 500);
    }

    const order = await env.DB.prepare(`
      SELECT id, status, customer_json, discount_code, discount_amount
      FROM orders WHERE paypal_order_id = ? LIMIT 1
    `).bind(orderID).first();
    if (!order) return json({ error: "Order not found." }, 404);
    if (order.status === "PAID") {
      return json({ success: true, status: "COMPLETED" });
    }

    const token = await getPayPalAccessToken(env);
    const base = getPayPalBaseUrl(env);
    const endpoint = `${base}/v2/checkout/orders/${encodeURIComponent(orderID)}`;
    const headers = { Authorization: `Bearer ${token}` };

    // Reconcile a previous successful capture whose database update failed.
    const checkResponse = await fetch(endpoint, { method: "GET", headers });
    if (!checkResponse.ok) {
      return json({ error: "Could not verify PayPal payment status. Please retry this order." }, 502);
    }
    const paypalOrder = await checkResponse.json();
    const usesTiny10 = order.discount_code === "TINY10" && Number(order.discount_amount) > 0;
    const customer = JSON.parse(order.customer_json || "{}");
    const email = usesTiny10 ? normalizedEmail(customer.email) : null;

    // A completed payment must be recorded even if discount checks have changed.
    if (paypalOrder.status === "COMPLETED") {
      const paidAt = new Date().toISOString();
      await env.DB.prepare(`
        UPDATE orders SET status = 'PAID', paypal_capture_json = ?, paid_at = ?
        WHERE paypal_order_id = ?
      `).bind(JSON.stringify(paypalOrder), paidAt, orderID).run();
      if (usesTiny10 && email) {
        await env.DB.prepare(`
          UPDATE discount_redemptions SET redeemed_at = ?
          WHERE LOWER(email) = ? AND UPPER(discount_code) = 'TINY10'
            AND paypal_order_id = ?
        `).bind(paidAt, email, orderID).run();
      }
      return json({ success: true, status: "COMPLETED", paypal: paypalOrder });
    }

    if (paypalOrder.status !== "APPROVED") {
      return json({ error: "PayPal payment has not been approved.", status: paypalOrder.status }, 400);
    }

    if (usesTiny10) {
      if (!email) return json({ error: "Invalid customer email for TINY10." }, 400);
      const priorPaid = await env.DB.prepare(`
        SELECT id FROM orders WHERE status = 'PAID' AND id != ?
          AND LOWER(TRIM(json_extract(customer_json, '$.email'))) = ? LIMIT 1
      `).bind(order.id, email).first();
      if (priorPaid) return json({ error: "TINY10 is for first-time customers only." }, 400);

      // Database UNIQUE index on normalized email + code is mandatory.
      const existingClaim = await findActiveTiny10Claim(env, email);
      if (existingClaim && existingClaim.paypal_order_id !== orderID) {
        return json({ error: "TINY10 is already reserved or used." }, 409);
      }
      const reservation = await env.DB.prepare(`
        INSERT INTO discount_redemptions
          (email, discount_code, paypal_order_id, discount_amount, redeemed_at)
        VALUES (?, 'TINY10', ?, ?, NULL)
        ON CONFLICT DO NOTHING
      `).bind(email, orderID, Number(order.discount_amount)).run();
      if (reservation.meta?.changes !== 1) {
        const owner = await env.DB.prepare(`
          SELECT paypal_order_id FROM discount_redemptions
          WHERE LOWER(TRIM(email)) = ? AND UPPER(TRIM(discount_code)) = 'TINY10' LIMIT 1
        `).bind(email).first();
        if (!owner || owner.paypal_order_id !== orderID) {
          return json({ error: "TINY10 has already been reserved or used." }, 409);
        }
      }
    }

    // Stable request ID makes retries of this specific PayPal capture idempotent.
    const captureResponse = await fetch(`${endpoint}/capture`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `capture-${order.id}`.slice(0, 108)
      }
    });
    const captureData = await captureResponse.json();
    if (!captureResponse.ok) {
      console.error("PayPal capture not confirmed:", captureData);
      return json({ error: "Payment could not be confirmed. Retry this same order; do not place a second order yet." }, 502);
    }

    const paid = captureData.status === "COMPLETED";
    const paidAt = paid ? new Date().toISOString() : null;
    await env.DB.prepare(`
      UPDATE orders SET status = ?, paypal_capture_json = ?, paid_at = ?
      WHERE paypal_order_id = ?
    `).bind(paid ? "PAID" : "PENDING", JSON.stringify(captureData), paidAt, orderID).run();
    if (paid && usesTiny10 && email) {
      await env.DB.prepare(`
        UPDATE discount_redemptions SET redeemed_at = ?
        WHERE LOWER(email) = ? AND UPPER(discount_code) = 'TINY10'
          AND paypal_order_id = ?
      `).bind(paidAt, email, orderID).run();
    }
    return json({ success: paid, status: captureData.status, paypal: captureData });
  } catch (error) {
    console.error("Capture order error:", error);
    return json({ error: "Unable to confirm payment. Retry the same order or contact us." }, 500);
  }
}

// ============================================
// ADMIN AUTHENTICATION
// ============================================

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

// ============================================
// WEBSITE VIEW TRACKING
// ============================================

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

    if (!page.startsWith("/") || page.length > 200) {
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

// ============================================
// ADMIN DASHBOARD STATISTICS
// ============================================

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

// ============================================
// ADMIN EMAIL SUBSCRIBERS (READ ONLY)
// ============================================

async function getAdminSubscribers(request, env) {
  const authError = adminError(request, env);
  if (authError) return authError;

  try {
    const result = await env.DB.prepare(`
      SELECT email, first_name, subscribed_at, status
      FROM email_subscribers
      ORDER BY subscribed_at DESC
      LIMIT 1000
    `).all();

    return json((result.results || []).map(row => ({
      email: row.email,
      firstName: row.first_name || "",
      subscribedAt: row.subscribed_at,
      status: row.status
    })));
  } catch (error) {
    console.error("Admin subscribers error:", error);
    return json({ error: "Unable to load email subscribers." }, 500);
  }
}

// ============================================
// ADMIN ORDER LIST
// ============================================

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

// ============================================
// SHIP / ARCHIVE / RESTORE ORDERS
// ============================================

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

// ============================================
// DELETE UNPAID TEST ORDERS (ADMIN ONLY)
// ============================================

async function deleteUnpaidOrder(request, env, orderId) {
  const authError = adminError(request, env);
  if (authError) return authError;

  if (!orderId || orderId.length > 150) {
    return json({ error: "Invalid order ID." }, 400);
  }

  if (!env.DB || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    return json({ error: "Payment verification is unavailable." }, 503);
  }

  try {
    const order = await env.DB.prepare(`
      SELECT id, status, paypal_order_id
      FROM orders WHERE id = ? LIMIT 1
    `).bind(orderId).first();

    if (!order) return json({ error: "Order not found." }, 404);
    if (order.status !== "PENDING" || !order.paypal_order_id) {
      return json({ error: "Only unpaid pending orders can be deleted." }, 409);
    }

    // A reserved TINY10 discount must not be orphaned by deletion.
    // Keep the order so the existing discount reconciliation can verify it.
    const claim = await env.DB.prepare(`
      SELECT paypal_order_id FROM discount_redemptions
      WHERE paypal_order_id = ? LIMIT 1
    `).bind(order.paypal_order_id).first();
    if (claim) {
      return json({
        error: "This order has a discount reservation. Contact support before deleting it."
      }, 409);
    }

    const token = await getPayPalAccessToken(env);
    const paypalResponse = await fetch(
      `${getPayPalBaseUrl(env)}/v2/checkout/orders/${encodeURIComponent(order.paypal_order_id)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!paypalResponse.ok) {
      return json({ error: "PayPal status could not be verified. Order was not deleted." }, 502);
    }

    const paypalOrder = await paypalResponse.json();
    // APPROVED might still be captured; COMPLETED is a real payment.
    // Unknown states must be treated as unsafe.
    const safeStatuses = ["CREATED", "PAYER_ACTION_REQUIRED", "VOIDED"];
    if (!safeStatuses.includes(paypalOrder.status)) {
      return json({
        error: "PayPal status is " + String(paypalOrder.status || "unknown") +
          ". This order cannot be safely deleted."
      }, 409);
    }

    // Recheck the local state in the DELETE itself so a concurrent capture
    // that has already marked the order PAID cannot be erased.
    const deleted = await env.DB.prepare(`
      DELETE FROM orders
      WHERE id = ? AND status = 'PENDING' AND paypal_order_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM discount_redemptions
          WHERE paypal_order_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_fulfillment
          WHERE order_id = ?
        )
    `).bind(orderId, order.paypal_order_id, order.paypal_order_id, orderId).run();

    if (deleted.meta?.changes !== 1) {
      return json({ error: "Order changed or has related records. Nothing was deleted." }, 409);
    }

    return json({ success: true });
  } catch (error) {
    console.error("Delete unpaid order error:", error);
    return json({ error: "Unable to safely delete this order." }, 500);
  }
}

// ============================================
// EMAIL MARKETING SETTINGS
// ============================================

const FIRST_ORDER_CODE = "TINY10";
const FIRST_ORDER_MINIMUM = 20;
const FIRST_ORDER_PERCENT = 10;
const FIRST_ORDER_MAX_SAVINGS = 5;

const EMAIL_FROM =
  "Tiny Memories Magnet Co. <hello@tinymemoriesmagnetco.com>";

function isSameSiteRequest(request) {
  const origin = request.headers.get("Origin");

  return !origin ||
    origin === new URL(request.url).origin;
}

function normalizedEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }

  return email;
}

function escapeEmailHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]
  );
}

// ============================================
// SEND EMAIL THROUGH RESEND
// ============================================

async function sendResendEmail(
  env,
  { to, subject, html, text, unsubscribeUrl, attachments }
) {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        html,
        text,
        ...(attachments ? { attachments } : {}),
        ...(unsubscribeUrl
          ? {
              headers: {
                "List-Unsubscribe": `<${unsubscribeUrl}>`
              }
            }
          : {})
      })
    }
  );

  if (!response.ok) {
    console.error(
      "Resend email delivery failed:",
      response.status
    );

    throw new Error("Email delivery failed.");
  }

  return response.json();
}

// ============================================
// EMAIL SIGNUP
// ============================================

async function subscribeToEmails(request, env) {
  if (!isSameSiteRequest(request)) {
    return json({ error: "Invalid origin." }, 403);
  }

  if (!env.DB) {
    return json({ error: "Database unavailable." }, 500);
  }

  try {
    const body = await request.json();

    if (body.website) {
      return json({ success: true });
    }

    const email = normalizedEmail(body.email);

    const firstName = String(
      body.firstName || ""
    ).trim().slice(0, 80);

    if (!email) {
      return json(
        { error: "Enter a valid email address." },
        400
      );
    }

    if (body.consent !== true) {
      return json(
        {
          error:
            "Please agree to receive marketing emails."
        },
        400
      );
    }

    const existing = await env.DB.prepare(`
      SELECT
        email,
        status,
        unsubscribe_token,
        welcome_sent_at
      FROM email_subscribers
      WHERE email = ?
    `).bind(email).first();

    const now = new Date().toISOString();

    const token =
      existing?.unsubscribe_token ||
      crypto.randomUUID();

    if (existing) {
      if (existing.status !== "subscribed") {
        await env.DB.prepare(`
          UPDATE email_subscribers
          SET
            first_name = ?,
            consent_at = ?,
            subscribed_at = ?,
            status = 'subscribed'
          WHERE email = ?
        `)
          .bind(firstName, now, now, email)
          .run();
      }
    } else {
      await env.DB.prepare(`
        INSERT INTO email_subscribers (
          email,
          first_name,
          subscribed_at,
          consent_at,
          status,
          unsubscribe_token,
          welcome_sent_at
        )
        VALUES (?, ?, ?, ?, 'subscribed', ?, NULL)
      `)
        .bind(
          email,
          firstName,
          now,
          now,
          token
        )
        .run();
    }

    // Keep welcome emails disabled until the
    // actual PayPal discount has been tested.
    if (
      env.WELCOME_DISCOUNT_READY === "true" &&
      !existing?.welcome_sent_at
    ) {
      const site = new URL(request.url).origin;

      const unsubscribeUrl =
        `${site}/api/unsubscribe?token=` +
        encodeURIComponent(token);

      const greeting = firstName
        ? `Hi ${escapeEmailHtml(firstName)},`
        : "Hello!";

      const html = `
        <div style="
          font-family: Georgia, serif;
          max-width: 580px;
          margin: auto;
          color: #383432;
          line-height: 1.7;
        ">
          <h1 style="color:#a96858">
            Welcome to Tiny Memories Magnet Co.!
          </h1>

          <p>${greeting}</p>

          <p>
            Thank you for joining our little community!
          </p>

          <p>
            Enjoy <strong>10% off your first order
            of $20 or more, up to $5</strong>
            with code:
          </p>

          <p style="
            font-size:28px;
            font-weight:bold;
            color:#a96858;
          ">
            ${FIRST_ORDER_CODE}
          </p>

          <p>
            Minimum $20 merchandise purchase.
            Shipping does not count toward
            the minimum. One use per customer.
          </p>

          <p>
            <a href="${site}/shop-magnets.html">
              Shop Handmade Magnets
            </a>
          </p>

          <p>
            <a href="${site}/custom-magnets.html">
              Create Custom Photo Magnets
            </a>
          </p>

          <p>
            Tiny memories. Big feelings.
          </p>

          <p style="font-size:12px">
            <a href="${unsubscribeUrl}">
              Unsubscribe
            </a>
          </p>
        </div>
      `;

      const text =
        "Welcome to Tiny Memories Magnet Co.! " +
        "Use TINY10 for 10% off your first order " +
        "of $20 or more, up to $5 savings. " +
        "Minimum $20 merchandise purchase, " +
        "excluding shipping. One use per customer. " +
        `Shop: ${site}/shop-magnets.html. ` +
        `Unsubscribe: ${unsubscribeUrl}`;

      try {
        await sendResendEmail(env, {
          to: email,
          subject:
            "Welcome to Tiny Memories — your first-order gift",
          html,
          text,
          unsubscribeUrl
        });

        await env.DB.prepare(`
          UPDATE email_subscribers
          SET welcome_sent_at = ?
          WHERE email = ?
            AND welcome_sent_at IS NULL
            AND status = 'subscribed'
        `)
          .bind(new Date().toISOString(), email)
          .run();

      } catch (error) {
        console.error(
          "Welcome email could not be sent:",
          error
        );
      }
    }

    return json({
      success: true,
      message:
        "Thank you for joining our email list!"
    });

  } catch (error) {
    console.error("Email signup error:", error);

    return json(
      { error: "Unable to save your subscription." },
      500
    );
  }
}

// ============================================
// UNSUBSCRIBE FROM MARKETING EMAILS
// ============================================

async function unsubscribeFromEmails(request, env) {
  const token =
    new URL(request.url).searchParams.get("token") || "";

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return new Response(
      "Invalid unsubscribe link.",
      { status: 400 }
    );
  }

  try {
    await env.DB.prepare(`
      UPDATE email_subscribers
      SET status = 'unsubscribed'
      WHERE unsubscribe_token = ?
    `).bind(token).run();

    return new Response(
      "You have been unsubscribed from " +
      "Tiny Memories Magnet Co. emails.",
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    );

  } catch (error) {
    console.error("Unsubscribe error:", error);

    return new Response(
      "Could not process unsubscribe request.",
      { status: 500 }
    );
  }
}

// ============================================
// VALIDATE TINY10 DISCOUNT
// ============================================

async function validateDiscount(request, env) {
  if (!isSameSiteRequest(request)) {
    return json({ error: "Invalid origin." }, 403);
  }

  if (!env.DB) {
    return json({ error: "Database unavailable." }, 500);
  }

  try {
    const body = await request.json();

    const code = String(body.discountCode || "")
      .trim()
      .toUpperCase();

    const email = normalizedEmail(body.email);

    if (code !== FIRST_ORDER_CODE) {
      return json({
        valid: false,
        error: "Invalid discount code."
      }, 400);
    }

    if (!email) {
      return json({
        valid: false,
        error: "Enter your email address first."
      }, 400);
    }

    // Recalculate merchandise pricing from the
    // actual cart. Never trust a subtotal supplied
    // by the customer's browser.
    const items = Array.isArray(body.cart)
      ? body.cart
      : Array.isArray(body.items)
        ? body.items
        : [];

    if (items.length === 0) {
      return json({
        valid: false,
        error: "Add products to your cart first."
      }, 400);
    }

    let priced;

    try {
      priced = priceCart(items);
    } catch (error) {
      return json({
        valid: false,
        error: error.message
      }, 400);
    }

    const merchandiseTotal = priced.merchandiseTotal;

    // $20 minimum applies to merchandise only.
    // Shipping is excluded.
    if (merchandiseTotal < FIRST_ORDER_MINIMUM) {
      return json({
        valid: false,
        minimumPurchase: FIRST_ORDER_MINIMUM,
        merchandiseTotal,
        amountNeeded: Number(
          (FIRST_ORDER_MINIMUM - merchandiseTotal).toFixed(2)
        ),
        error:
          "Spend at least $20 on merchandise to use TINY10."
      }, 400);
    }

    const subscriber = await env.DB.prepare(`
      SELECT email
      FROM email_subscribers
      WHERE email = ?
        AND status = 'subscribed'
      LIMIT 1
    `).bind(email).first();

    if (!subscriber) {
      return json({
        valid: false,
        error: "This offer is for email subscribers."
      }, 400);
    }

    const previousOrder = await env.DB.prepare(`
      SELECT id
      FROM orders
      WHERE status = 'PAID'
        AND LOWER(
          TRIM(json_extract(customer_json, '$.email'))
        ) = ?
      LIMIT 1
    `).bind(email).first();

    if (previousOrder) {
      return json({
        valid: false,
        error: "This offer is for first-time customers."
      }, 400);
    }

    const redemption = await findActiveTiny10Claim(env, email);

    if (redemption) {
      return json({
        valid: false,
        error: "This discount has already been used."
      }, 400);
    }

    const discountAmount = Number(
      Math.min(
        merchandiseTotal * (FIRST_ORDER_PERCENT / 100),
        FIRST_ORDER_MAX_SAVINGS
      ).toFixed(2)
    );

    const shippingTotal = calculateShipping(items);

    const estimatedTotal = Number(
      (
        merchandiseTotal -
        discountAmount +
        shippingTotal
      ).toFixed(2)
    );

    return json({
      valid: true,
      discountCode: FIRST_ORDER_CODE,
      percentage: FIRST_ORDER_PERCENT,
      minimumPurchase: FIRST_ORDER_MINIMUM,
      maximumDiscount: FIRST_ORDER_MAX_SAVINGS,
      merchandiseTotal,
      discountAmount,
      shippingTotal,
      estimatedTotal,
      message:
        "TINY10 is eligible for this cart and email."
    });

  } catch (error) {
    console.error("Discount validation error:", error);

    return json({
      error: "Unable to validate discount."
    }, 500);
  }
}

async function calculateTiny10Discount(env, email, merchandiseTotal) {
  const normalized = normalizedEmail(email);

  if (!normalized) {
    throw new Error("Enter a valid email address to use TINY10.");
  }

  if (merchandiseTotal < 20) {
    throw new Error(
      "Spend at least $20 on merchandise to use TINY10."
    );
  }

  const subscriber = await env.DB.prepare(`
    SELECT email
    FROM email_subscribers
    WHERE LOWER(email) = ?
      AND status = 'subscribed'
    LIMIT 1
  `).bind(normalized).first();

  if (!subscriber) {
    throw new Error(
      "TINY10 is available to email subscribers only."
    );
  }

  const previousOrder = await env.DB.prepare(`
    SELECT id
    FROM orders
    WHERE status = 'PAID'
      AND LOWER(
        TRIM(json_extract(customer_json, '$.email'))
      ) = ?
    LIMIT 1
  `).bind(normalized).first();

  if (previousOrder) {
    throw new Error(
      "TINY10 is for first-time customers only."
    );
  }

  const alreadyUsed = await findActiveTiny10Claim(env, normalized);

  if (alreadyUsed) {
    throw new Error(
      "TINY10 has already been used."
    );
  }

  const discountCents = Math.min(
    500,
    Math.round(merchandiseTotal * 100 * 0.10)
  );

  return discountCents / 100;
}
// Custom design requests are emailed to the shop, not charged.
async function submitSaveDateRequest(request, env) {
  if (!isSameSiteRequest(request)) return json({error:"Invalid origin."},403);
  try {
    const body = await request.json();
    if (body.website) return json({success:true});
    const email = normalizedEmail(body.email);
    const name = String(body.name || "").trim().slice(0,150);
    const details = body.details || {};
    const names = String(details.names || "").trim().slice(0,200);
    const date = String(details.date || "").trim().slice(0,100);
    const colors = String(details.colors || "").trim().slice(0,500);
    const design = String(details.design || "").trim().slice(0,100);
    const ideas = String(details.ideas || "").trim().slice(0,2000);
    const wording = String(details.wording || "").trim().slice(0,1000);
    const quantity = Number(body.quantity);
    if (!email || !name || !names || !date || !design || ![50,75,100,150,200].includes(quantity)) {
      return json({error:"Please complete the required request details."},400);
    }
    const photo = String(body.photo || "");
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(photo);
    if (!match || photo.length > 450000) return json({error:"Please upload a valid compressed photo."},400);
    const lines = ["New Save the Date custom design request",`Customer: ${name}`,`Email: ${email}`,`Sets: ${quantity}`,`Names: ${names}`,`Date: ${date}`,`Design: ${design}`,`Colors: ${colors}`,`Wording: ${wording}`,`Ideas: ${ideas}`,`Envelopes: ${details.envelopes === "quote" ? "Quote requested" : "Not needed"}`];
    const message = lines.join("\n");
    await sendResendEmail(env, {
      to:"tinymemoriesmagnetco@outlook.com",
      subject:"New Save the Date custom request",
      html:"<pre style=\"white-space:pre-wrap;font-family:Arial,sans-serif\">"+escapeEmailHtml(message)+"</pre>",
      text:message,
      attachments:[{filename:"save-the-date-photo."+(match[1]==="jpeg"?"jpg":match[1]),content:match[2]}]
    });
    return json({success:true});
  } catch(error) {
    console.error("Save the Date request error:",error);
    return json({error:"Could not send your request. Please email us directly."},500);
  }
}

// ============================================
// VENDOR MARKET: separate D1 table and private R2 photos
// Required bindings: DB (D1), VENDOR_PHOTOS (R2), ADMIN_PASSWORD (secret).
// ============================================
const VENDOR_PRICES = { 1: 3, 3: 9, 6: 18, 9: 24 };
const VENDOR_MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const VENDOR_MAX_REQUEST_BYTES = 9 * VENDOR_MAX_PHOTO_BYTES + 1000000;
function vendorOriginOK(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
function vendorFileType(bytes, filename) {
  const a = new Uint8Array(bytes.slice(0, 16));
  if (a[0] === 255 && a[1] === 216 && a[2] === 255) return "image/jpeg";
  if (a[0] === 137 && a[1] === 80 && a[2] === 78 && a[3] === 71 && a[4] === 13 && a[5] === 10) return "image/png";
  const boxType = String.fromCharCode(...a.slice(4, 8));
  const heicBrand = String.fromCharCode(...a.slice(8, 12));
  if (boxType === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(heicBrand)) return "image/heic";
  return null;
}
async function submitVendorOrder(request, env) {
  if (!vendorOriginOK(request)) return json({error:"Invalid origin."},403);
  if (!env.DB || !env.VENDOR_PHOTOS) return json({error:"Vendor storage is not configured."},503);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > VENDOR_MAX_REQUEST_BYTES) return json({error:"Photos exceed upload limit."},413);
  let uploaded = [];
  let saved = false;
  try {
    const form = await request.formData();
    const name = String(form.get("customerName") || "").trim().slice(0,100);
    const contact = String(form.get("contact") || "").trim().slice(0,160);
    const notes = String(form.get("notes") || "").trim().slice(0,500);
    const quantity = Number(form.get("bundle"));
    const photos = form.getAll("photos");
    if (!name || !Object.hasOwn(VENDOR_PRICES, quantity) || photos.length !== quantity) {
      return json({error:"Enter your name and upload exactly one photo per magnet."},400);
    }
    const validated = [];
    for (const photo of photos) {
      if (typeof photo === "string" || !photo.size || photo.size > VENDOR_MAX_PHOTO_BYTES) {
        return json({error:"Each photo must be between 1 byte and 15 MB."},400);
      }
      const bytes = await photo.arrayBuffer();
      const type = vendorFileType(bytes, photo.name);
      if (!type) return json({error:"Only JPG, PNG, or HEIC photos are supported."},400);
      validated.push({bytes, type});
    }
    const orderId = "VM-" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const photoKeys = [];
    for (let i = 0; i < validated.length; i++) {
      const file = validated[i];
      const ext = file.type === "image/png" ? "png" : file.type === "image/heic" ? "heic" : "jpg";
      const key = `vendor/${orderId}/${i + 1}.${ext}`;
      await env.VENDOR_PHOTOS.put(key, file.bytes, {httpMetadata:{contentType:file.type}});
      uploaded.push(key);
      photoKeys.push(key);
    }
    await env.DB.prepare(`INSERT INTO vendor_orders
      (id, created_at, customer_name, contact, notes, quantity, total, status, photo_keys_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'AWAITING_PAYMENT', ?)`)
      .bind(orderId, new Date().toISOString(), name, contact, notes, quantity,
        VENDOR_PRICES[quantity], JSON.stringify(photoKeys)).run();
    saved = true;
    return json({orderId, quantity, total:VENDOR_PRICES[quantity], status:"AWAITING_PAYMENT"},201);
  } catch (err) {
    console.error("Vendor order error:",err);
    return json({error:"Unable to save order. Please ask for help at the booth."},500);
  } finally {
    if (!saved) for (const key of uploaded) { try { await env.VENDOR_PHOTOS.delete(key); } catch(e) { console.error("Orphan cleanup failed", e); } }
  }
}
async function listVendorOrders(request, env) {
  const auth = adminError(request,env); if (auth) return auth;
  if (!env.DB) return json({error:"Database unavailable."},503);
  try {
    const rows = await env.DB.prepare(`SELECT id,created_at,customer_name,contact,notes,quantity,total,status,paid_at,ready_at,picked_up_at,photo_keys_json
      FROM vendor_orders ORDER BY created_at DESC LIMIT 200`).all();
    return json((rows.results || []).map(r=>({id:r.id,createdAt:r.created_at,name:r.customer_name,
      contact:r.contact,notes:r.notes,quantity:r.quantity,total:r.total,status:r.status,
      paidAt:r.paid_at,readyAt:r.ready_at,pickedUpAt:r.picked_up_at,
      photoCount:JSON.parse(r.photo_keys_json).length})));
  } catch(e) {console.error(e);return json({error:"Unable to load vendor orders."},500);}
}
async function getVendorPhoto(request,env,id,index) {
  const auth = adminError(request,env); if(auth) return auth;
  if(!env.DB || !env.VENDOR_PHOTOS) return json({error:"Storage unavailable."},503);
  if(!/^VM-[0-9A-F]{8}$/.test(id) || !Number.isSafeInteger(index)) return json({error:"Invalid photo."},400);
  const row = await env.DB.prepare("SELECT photo_keys_json FROM vendor_orders WHERE id=?").bind(id).first();
  if(!row) return json({error:"Order not found."},404);
  const keys = JSON.parse(row.photo_keys_json);
  if(index < 1 || index > keys.length) return json({error:"Photo not found."},404);
  const object = await env.VENDOR_PHOTOS.get(keys[index-1]);
  if(!object) return json({error:"Photo missing from storage."},404);
  return new Response(object.body,{headers:{"Content-Type":object.httpMetadata?.contentType || "application/octet-stream",
    "Cache-Control":"private, no-store", "Content-Disposition":`attachment; filename="${id}-photo-${index}.${(keys[index-1].split('.').pop())}"`,
    "X-Content-Type-Options":"nosniff"}});
}
async function setVendorStatus(request,env,id) {
  const auth=adminError(request,env);if(auth)return auth;
  if(!vendorOriginOK(request)) return json({error:"Invalid origin."},403);
  if(!/^VM-[0-9A-F]{8}$/.test(id))return json({error:"Invalid order ID."},400);
  const {status}=await request.json();
  const transitions={AWAITING_PAYMENT:["PAID"],PAID:["IN_PROGRESS"],IN_PROGRESS:["READY"],READY:["PICKED_UP"]};
  if(!["PAID","IN_PROGRESS","READY","PICKED_UP"].includes(status))return json({error:"Invalid status."},400);
  const now=new Date().toISOString();
  const row=await env.DB.prepare("SELECT status FROM vendor_orders WHERE id=?").bind(id).first();
  if(!row)return json({error:"Order not found."},404);
  if(!transitions[row.status]?.includes(status))return json({error:"Invalid status transition."},409);
  const result=await env.DB.prepare(`UPDATE vendor_orders SET status=?,
    paid_at=CASE WHEN ?='PAID' THEN ? ELSE paid_at END,
    ready_at=CASE WHEN ?='READY' THEN ? ELSE ready_at END,
    picked_up_at=CASE WHEN ?='PICKED_UP' THEN ? ELSE picked_up_at END
    WHERE id=? AND status=?`).bind(status,status,now,status,now,status,now,id,row.status).run();
  if(result.meta?.changes!==1)return json({error:"Order changed; refresh and retry."},409);
  return json({success:true,status});
}
