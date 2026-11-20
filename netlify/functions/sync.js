const districts = require('./districts.json');

const SENDIT_PUBLIC_KEY = '9588aef340a5bf2b1c3f634db54b6b55';
const SENDIT_SECRET_KEY = '9DZhCRTbCbOe0uUHzmoFvUTbt5WvHnFQ';

const CHANTAN_SUPABASE_URL = 'https://crpmsfhcdohzbmvnimjb.supabase.co';
const CHANTAN_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNycG1zZmhjZG9oemJtdm5pbWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5NjIwMDAsImV4cCI6MjEwOTUzODAwMH0.SgbMGmdU5eaBJRW48jT0yQ8lJlSEPOqWaZIYRXLLONM';
const CHANTAN_EMAIL = 'ilyasezzaari@gmail.com';
const CHANTAN_PASSWORD = 'Trend2026%';

const DEFAULT_PICKUP_ID = 13; // Casablanca - Bernoussi

function stripAccents(str) {
    if (!str) return '';
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function matchDistrict(cityName) {
    const clean = stripAccents(cityName);
    const aliases = {
        'tangier': 52, 'tanger': 52,
        'laayoune': 162, 'layoune': 162, 'el aaiun': 162,
        'casablanca': 46, 'casa': 46,
        'rabat': 53,
        'marrakech': 56, 'kech': 56,
        'fes': 54, 'fez': 54,
        'agadir': 55,
        'oujda': 57,
        'kenitra': 58,
        'tetouan': 59,
        'meknes': 60,
        'temara': 65,
        'sale': 66,
        'nador': 105,
        'berrechid': 106,
        'settat': 107,
        'el jadida': 108,
        'safi': 109,
        'beni mellal': 110,
        'khouribga': 111,
        'mohammedia': 114
    };

    if (aliases[clean]) return aliases[clean];

    for (const d of districts) {
        const dName = stripAccents(d.name);
        if (dName === clean || dName.includes(clean) || clean.includes(dName)) {
            return d.id;
        }
    }
    return 46; // Casablanca default
}

async function getSenditToken() {
    const res = await fetch('https://app.sendit.ma/api/v1/login', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ public_key: SENDIT_PUBLIC_KEY, secret_key: SENDIT_SECRET_KEY })
    });
    const data = await res.json();
    return data?.data?.token;
}

async function getChantanToken() {
    const res = await fetch(`${CHANTAN_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': CHANTAN_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: CHANTAN_EMAIL, password: CHANTAN_PASSWORD })
    });
    const data = await res.json();
    return data?.access_token;
}

async function createSenditDelivery(senditToken, order) {
    const destDistrictId = matchDistrict(order.city || 'Casablanca');
    const items = order.items || [];
    const itemsDesc = items.map(it => `${it.name || 'Article'} (${it.color || ''}/${it.size || ''}) x${it.qty || 1}`).join(', ');
    const rawPhone = String(order.phone || '').replace(/[^0-9]/g, '');

    let addr = (order.address || '').trim();
    if (!addr || addr.length < 3) {
        addr = `${order.city || 'Maroc'} (Client à contacter par téléphone pour adresse exacte)`;
    }

    const payload = {
        pickup_district_id: DEFAULT_PICKUP_ID,
        district_id: destDistrictId,
        name: order.customer_name || 'Client',
        phone: rawPhone,
        address: addr,
        amount: parseFloat(order.grand_amount || order.total_price || 0),
        reference: String(order.id || '').substring(0, 8),
        comment: itemsDesc.substring(0, 250),
        allow_open: 1,
        allow_try: 1
    };

    const res = await fetch('https://app.sendit.ma/api/v1/deliveries', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${senditToken}`,
            'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data?.data || {};
}

exports.handler = async function (event, context) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: 'OK' };
    }

    try {
        const senditToken = await getSenditToken();
        const chantanToken = await getChantanToken();

        if (!senditToken || !chantanToken) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'Failed to authenticate with Sendit or Supabase' })
            };
        }

        const authHeaders = {
            'apikey': CHANTAN_ANON_KEY,
            'Authorization': `Bearer ${chantanToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };

        // Check if a specific record was posted (e.g. Supabase DB Webhook)
        let incomingOrder = null;
        if (event.body) {
            try {
                const body = JSON.parse(event.body);
                incomingOrder = body.record || body.order || (body.id ? body : null);
            } catch (e) {}
        }

        let ordersToProcess = [];
        if (incomingOrder && (incomingOrder.stage === 'preparation' || incomingOrder.stage === 'en_preparation') && !incomingOrder.tracking_code) {
            ordersToProcess.push(incomingOrder);
        } else {
            // Query Supabase for pending preparation orders
            const ordersRes = await fetch(`${CHANTAN_SUPABASE_URL}/rest/v1/orders?stage=in.(preparation,en_preparation)&select=*&order=created_at.desc`, {
                headers: authHeaders
            });
            const allPrep = await ordersRes.json();
            ordersToProcess = (allPrep || []).filter(o => !o.tracking_code || o.carrier !== 'Sendit');
        }

        const results = [];
        for (const ord of ordersToProcess) {
            try {
                const delivery = await createSenditDelivery(senditToken, ord);
                const tracking = delivery.code;
                const fee = parseFloat(delivery.fee || 35);
                const labelUrl = delivery.labelUrl;

                if (!tracking) {
                    results.push({ id: ord.id, success: false, error: 'No tracking code returned by Sendit' });
                    continue;
                }

                const history = ord.history || [];
                history.push({
                    t: new Date().toISOString(),
                    by: 'Netlify Cloud Bridge',
                    what: `Colis Sendit créé • N° ${tracking} (${fee} DH)`
                });

                const updatePayload = {
                    carrier: 'Sendit',
                    stage: 'expediee',
                    tracking_code: tracking,
                    ship_amount: fee,
                    note: `Tracking Sendit: ${tracking} | Label: ${labelUrl}`,
                    history: history
                };

                const upRes = await fetch(`${CHANTAN_SUPABASE_URL}/rest/v1/orders?id=eq.${ord.id}`, {
                    method: 'PATCH',
                    headers: authHeaders,
                    body: JSON.stringify(updatePayload)
                });

                results.push({
                    id: ord.id,
                    customer: ord.customer_name,
                    tracking: tracking,
                    fee: fee,
                    labelUrl: labelUrl,
                    success: true
                });
            } catch (err) {
                results.push({ id: ord.id, success: false, error: err.message });
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: 'success',
                timestamp: new Date().toISOString(),
                orders_processed: results.length,
                details: results
            })
        };
    } catch (err) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message })
        };
    }
};
