export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

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

        const createRes = await fetch(
          `${process.env.SUPABASE_URL}/auth/v1/admin/users`,
          {
            method: 'POST',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password: tempPassword, email_confirm: true })
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
            await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
              method: 'PUT',
              headers: {
                'apikey': process.env.SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ password: tempPassword })
            });
          }
        }

        if (userId) {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles`, {
            method: 'POST',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({ id: userId, email, is_pro: true })
          });

          await sendWelcomeEmail(email, tempPassword);

          await fetch(`${process.env.SUPABASE_URL}/rest/v1/pagos`, {
            method: 'POST',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, importe: 4.99, moneda: 'EUR', stripe_session_id: session.id })
          });
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

function generatePassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  let pass = '';
  for (let i = 0; i < 10; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
}

async function sendWelcomeEmail(email, password) {
  if (!process.env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'EntrIA <noreply@entriajobs.com>',
      to: email,
      subject: 'Bienvenido a EntrIA Pro — Tus credenciales de acceso',
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px">
        <h1 style="font-size:28px;color:#1a1814">Entr<span style="color:#2d6a4f">IA</span></h1>
        <h2>¡Ya eres Pro! 🎉</h2>
        <p>Tus credenciales de acceso:</p>
        <div style="background:#f5f2ec;border-radius:12px;padding:20px;margin:20px 0">
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Contraseña temporal:</strong> <span style="font-size:18px;color:#2d6a4f;font-weight:700">${password}</span></p>
        </div>
        <a href="https://entriajobs.com" style="display:block;background:#2d6a4f;color:white;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600">Acceder a EntrIA Pro →</a>
        <p style="color:#5a5650;font-size:13px;margin-top:20px">¿Dudas? info@entriajobs.com</p>
      </div>`
    })
  });
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',');
    let timestamp = '', signature = '';
    for (const part of parts) {
      if (part.startsWith('t=')) timestamp = part.slice(2);
      if (part.startsWith('v1=')) signature = part.slice(3);
    }
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === signature;
  } catch { return false; }
}
