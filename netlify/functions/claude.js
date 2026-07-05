// Netlify serverless function — proxies calls to Anthropic API
// Place this file at: netlify/functions/claude.js
// Set ANTHROPIC_API_KEY in Netlify dashboard → Site settings → Environment variables

exports.handler = async function(event) {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "API key not configured. Add ANTHROPIC_API_KEY to Netlify environment variables." })
    };
  }

  try {
    const body = JSON.parse(event.body);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };
  } catch (err) {
    console.error("Proxy error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Proxy error: " + err.message })
    };
  }
};
