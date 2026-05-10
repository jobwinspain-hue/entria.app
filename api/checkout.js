export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email } = req.body;

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const priceId = 'price_1TUZxP6f53qziEHWKiQY4i9v';

    console.log('stripe key exists:', !!stripeKey);
    console.log('price id:', priceId);

    const params = new URLSearchParams({
      'payment_method_types[]': 'card',
      'line_items[0][price]': priceId,
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
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    const session = await response.json();
    console.log('stripe response:', JSON.stringify(session).substring(0, 200));

    if (session.url) {
      return res.status(200).json({ url: session.url });
    } else {
      return res.status(500).json({ error: 'Stripe error', details: session });
    }
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
