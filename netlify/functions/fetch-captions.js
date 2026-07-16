// netlify/functions/fetch-captions.js
//
// Fetches auto-generated (or uploaded) YouTube captions for a given video
// and returns them as plain text. This runs server-side because browsers
// cannot fetch YouTube's caption files directly (CORS).
//
// IMPORTANT — this uses YouTube's public caption track data embedded in the
// video page, not an official API. YouTube does not guarantee this format
// stays stable, and (as of this writing) is known to sometimes block or
// rate-limit requests from datacenter IPs (Netlify's servers included) with
// a 429, a CAPTCHA-style challenge, or an EU cookie-consent redirect instead
// of the real page. The CONSENT cookie below avoids the consent-redirect
// case specifically; the 429/challenge case has no reliable server-side fix
// — if that happens, "paste the transcript manually" is the fallback.
//
// No external npm dependencies — uses only Node's built-in https module,
// so no package.json / install step is needed for this function to deploy.

const https = require("https");

function fetchUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            // Skips YouTube's EU cookie-consent interstitial, which otherwise
            // replaces the real page (and its caption data) with a consent form.
            Cookie: "CONSENT=YES+1"
          }
        },
        function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve(fetchUrl(res.headers.location, redirects + 1));
            return;
          }
          var data = "";
          res.on("data", function (chunk) {
            data += chunk;
          });
          res.on("end", function () {
            resolve({ statusCode: res.statusCode, body: data });
          });
        }
      )
      .on("error", reject);
  });
}

function extractVideoId(url) {
  var m = (url || "").match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

exports.handler = async function (event) {
  var headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: headers, body: "" };
  }

  try {
    var url = (event.queryStringParameters && event.queryStringParameters.url) || "";
    var videoId = extractVideoId(url);
    if (!videoId) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: "Could not find a YouTube video ID in that URL. Please check the link and try again." })
      };
    }

    var page = await fetchUrl("https://www.youtube.com/watch?v=" + videoId);

    if (page.statusCode === 429) {
      return {
        statusCode: 429,
        headers: headers,
        body: JSON.stringify({ error: "YouTube is rate-limiting requests from our server right now (HTTP 429). This isn't about your video — try again in a few minutes, or paste the transcript manually for now." })
      };
    }
    if (page.statusCode !== 200) {
      return {
        statusCode: 502,
        headers: headers,
        body: JSON.stringify({ error: "YouTube returned an unexpected response (HTTP " + page.statusCode + "). The video may be private, age-restricted, or region-locked. Please paste the transcript manually." })
      };
    }
    if (/consent\.youtube\.com|"CONSENT_DECLINED"/.test(page.body)) {
      return {
        statusCode: 502,
        headers: headers,
        body: JSON.stringify({ error: "YouTube showed a cookie-consent page instead of the video. Please try again — if this keeps happening, paste the transcript manually." })
      };
    }

    var match = page.body.match(/"captionTracks":(\[.*?\])/);
    if (!match) {
      var looksBlocked = page.body.length < 5000;
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({
          error: looksBlocked
            ? "YouTube returned a very short page, which usually means the request was blocked rather than that captions are missing. Try again shortly, or paste the transcript manually."
            : "No captions found for this video. It may not have captions/auto-captions enabled."
        })
      };
    }

    var tracks;
    try {
      tracks = JSON.parse(match[1]);
    } catch (e) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: "Could not read caption data for this video — YouTube may have changed its page format." })
      };
    }

    if (!tracks || !tracks.length) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ error: "No caption tracks are available for this video." })
      };
    }

    // Prefer an English track; otherwise fall back to whatever is available.
    var track = tracks.filter(function (t) {
      return (t.languageCode || "").indexOf("en") === 0;
    })[0] || tracks[0];

    if (!track || !track.baseUrl) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: "Found a caption track but it had no usable URL." })
      };
    }

    var captionRes = await fetchUrl(track.baseUrl);
    if (captionRes.statusCode !== 200) {
      return {
        statusCode: 502,
        headers: headers,
        body: JSON.stringify({ error: "Could not download the caption file (HTTP " + captionRes.statusCode + "). Please try again." })
      };
    }

    var textMatches = captionRes.body.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];

    if (!textMatches.length) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ error: "The caption file for this video was empty or in an unexpected format." })
      };
    }

    var transcript = textMatches
      .map(function (block) {
        var inner = block.replace(/^<text[^>]*>/, "").replace(/<\/text>$/, "");
        return decodeHtmlEntities(inner.replace(/<[^>]+>/g, "")).trim();
      })
      .filter(Boolean)
      .join(" ");

    if (!transcript.trim()) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ error: "Captions were found but contained no readable text." })
      };
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ transcript: transcript, language: track.languageCode || "unknown" })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: "Something went wrong fetching captions: " + (err && err.message ? err.message : "unknown error") })
    };
  }
};
