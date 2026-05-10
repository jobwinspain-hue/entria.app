export const config = { runtime: 'edge' };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(request) {

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);

  // ─── RUTA 1: Proxy a Anthropic ───────────────────────────────
  if (url.pathname === '/api/proxy' || url.pathname === '/api/proxy/') {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    try {
      const body = await request.json();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  // ─── RUTA 2: Crear sesión de pago de Stripe ──────────────────
  if (url.pathname === '/api/proxy/checkout' && request.method === 'POST') {
    try {
      const { email } = await request.json();

      const params = new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price]': process.env.STRIPE_PRICE_ID,
        'line_items[0][quantity]': '1',
        'mode': 'payment',
        'customer_email': email,
        'success_url': 'https://entriajobs.com?pago=ok&email=' + encodeURIComponent(email),
        'cancel_url': 'https://entriajobs.com?pago=cancelado',
        'metadata[email]': email,
      });

      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString()
      });

      const session = await response.json();
      return new Response(JSON.stringify({ url: session.url }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  // ─── RUTA 3: Webhook de Stripe ───────────────────────────────
  if (url.pathname === '/api/proxy/webhook' && request.method === 'POST') {
    try {
      const body = await request.text();
      const sig = request.headers.get('stripe-signature');

      const isValid = await verifyStripeSignature(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      if (!isValid) {
        return new Response('Invalid signature', { status: 400 });
      }

      const event = JSON.parse(body);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_email || session.metadata?.email;

        if (email) {
          const tempPassword = generatePassword();

          // 1. Crear usuario en Supabase Auth
          const createRes = await fetch(
            `${process.env.SUPABASE_URL}/auth/v1/admin/users`,
            {
              method: 'POST',
              headers: {
                'apikey': process.env.SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                email,
                password: tempPassword,
                email_confirm: true
              })
            }
          );

          const userData = await createRes.json();
          let userId = userData?.id;

          if (!userId) {
            const listRes = await fetch(
              `${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`,
              {
                headers: {
                  'apikey': process.env.SUPABASE_SERVICE_KEY,
                  'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                }
              }
            );
            const listData = await listRes.json();
            const found = listData?.users?.find(u => u.email === email);
            userId = found?.id;

            if (userId) {
              await fetch(
                `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
                {
                  method: 'PUT',
                  headers: {
                    'apikey': process.env.SUPABASE_SERVICE_KEY,
                    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ password: tempPassword })
                }
              );
            }
          }

          if (userId) {
            // 2. Activar Pro en Supabase
            await fetch(
              `${process.env.SUPABASE_URL}/rest/v1/profiles`,
              {
                method: 'POST',
                headers: {
                  'apikey': process.env.SUPABASE_SERVICE_KEY,
                  'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                  'Content-Type': 'application/json',
                  'Prefer': 'resolution=merge-duplicates'
                },
                body: JSON.stringify({ id: userId, email, is_pro: true })
              }
            );

            // 3. Email de bienvenida
            await sendWelcomeEmail(email, tempPassword);

            // 4. Registrar pago
            await fetch(
              `${process.env.SUPABASE_URL}/rest/v1/pagos`,
              {
                method: 'POST',
                headers: {
                  'apikey': process.env.SUPABASE_SERVICE_KEY,
                  'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  email,
                  importe: 4.99,
                  moneda: 'EUR',
                  stripe_session_id: session.id
                })
              }
            );
          }
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Not found', { status: 404 });
}

function generatePassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  let pass = '';
  for (let i = 0; i < 10; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

async function sendWelcomeEmail(email, password) {
  const subject = 'Bienvenido a EntrIA Pro — Tus credenciales de acceso';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px">
      <div style="text-align:center;margin-bottom:32px">
        <h1 style="font-size:28px;color:#1a1814;margin:0">Entr<span style="color:#2d6a4f">IA</span></h1>
        <div style="font-size:12px;background:#d8f3dc;color:#2d6a4f;padding:3px 10px;border-radius:10px;display:inline-block;margin-top:6px;font-weight:700">PRO</div>
      </div>
      <h2 style="font-size:22px;color:#1a1814;margin-bottom:8px">¡Ya eres Pro! 🎉</h2>
      <p style="color:#5a5650;line-height:1.6;margin-bottom:24px">Gracias por confiar en EntrIA. Aquí tienes tus credenciales de acceso:</p>
      <div style="background:#f5f2ec;border-radius:12px;padding:20px 24px;margin-bottom:24px">
        <div style="margin-bottom:12px">
          <div style="font-size:12px;color:#5a5650;font-weight:600;margin-bottom:4px">EMAIL</div>
          <div style="font-size:15px;color:#1a1814;font-weight:500">${email}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#5a5650;font-weight:600;margin-bottom:4px">CONTRASEÑA TEMPORAL</div>
          <div style="font-size:18px;color:#2d6a4f;font-weight:700;letter-spacing:1px">${password}</div>
        </div>
      </div>
      <a href="https://entriajobs.com" style="display:block;background:#2d6a4f;color:white;text-align:center;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Acceder a EntrIA Pro →</a>
      <p style="color:#5a5650;font-size:13px;text-align:center;margin-top:24px">¿Alguna duda? Escríbenos a info@entriajobs.com</p>
    </div>
  `;

  if (process.env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'EntrIA <noreply@entriajobs.com>',
        to: email,
        subject,
        html
      })
    });
  }
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',');
    let timestamp = '';
    let signature = '';
    for (const part of parts) {
      if (part.startsWith('t=')) timestamp = part.slice(2);
      if (part.startsWith('v1=')) signature = part.slice(3);
    }
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const computedSig = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return computedSig === signature;
  } catch {
    return false;
  }
}
