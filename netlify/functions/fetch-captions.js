// netlify/functions/fetch-captions.js
//
// Fetches auto-generated (or uploaded) YouTube captions for a given video
// and returns them as plain text. This runs server-side because browsers
// cannot fetch YouTube's caption files directly (CORS).
//
// APPROACH: calls YouTube's internal "innertube" player API directly
// (the same endpoint YouTube's own Android app calls) rather than scraping
// the watch-page HTML. This is more reliable than the HTML-scrape approach
// because caption metadata is not always embedded in the static page HTML
// anymore — it's often only available through this internal API call.
//
// The API key below is NOT a secret credential — it's a public key that
// ships inside every YouTube web/mobile client and is used openly in most
// well-known open-source YouTube-transcript tools. It identifies the
// calling client type to YouTube, nothing more.
//
// IMPORTANT — this is still an unofficial method. YouTube does not
// guarantee this endpoint or its response shape stays stable. If this ever
// silently stops working, that's almost certainly why. "Paste the
// transcript manually" is always the fallback.
//
// No external npm dependencies — uses only Node's built-in https module,
// so no package.json / install step is needed for this function to deploy.

const https = require("https");

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

function postJson(url, payload) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify(payload);
    var u = new URL(url);
    var req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip"
        }
      },
      function (res) {
        var data = "";
        res.on("data", function (chunk) {
          data += chunk;
        });
        res.on("end", function () {
          resolve({ statusCode: res.statusCode, body: data });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(getUrl(res.headers.location, redirects + 1));
          return;
        }
        var data = "";
        res.on("data", function (chunk) {
          data += chunk;
        });
        res.on("end", function () {
          resolve({ statusCode: res.statusCode, body: data });
        });
      })
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

    var playerRes = await postJson("https://www.youtube.com/youtubei/v1/player?key=" + INNERTUBE_KEY, {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "19.09.37",
          androidSdkVersion: 34,
          hl: "en",
          gl: "US"
        }
      },
      videoId: videoId
    });

    if (playerRes.statusCode === 429) {
      return {
        statusCode: 429,
        headers: headers,
        body: JSON.stringify({ error: "YouTube is rate-limiting requests from our server right now (HTTP 429). This isn't about your video — try again in a few minutes, or paste the transcript manually for now." })
      };
    }
    if (playerRes.statusCode !== 200) {
      return {
        statusCode: 502,
        headers: headers,
        body: JSON.stringify({ error: "YouTube returned an unexpected response (HTTP " + playerRes.statusCode + "). Please paste the transcript manually." })
      };
    }

    var data;
    try {
      data = JSON.parse(playerRes.body);
    } catch (e) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: "Could not read YouTube's response — it may have changed its API format." })
      };
    }

    var playability = data.playabilityStatus && data.playabilityStatus.status;
    if (playability && playability !== "OK") {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({
          error: "YouTube says this video is " + playability.toLowerCase().replace(/_/g, " ") + (data.playabilityStatus.reason ? " (" + data.playabilityStatus.reason + ")" : "") + ". Please check the video is public and try again, or paste the transcript manually."
        })
      };
    }

    var tracks =
      data.captions &&
      data.captions.playerCaptionsTracklistRenderer &&
      data.captions.playerCaptionsTracklistRenderer.captionTracks;

    if (!tracks || !tracks.length) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ error: "No captions/auto-captions are available for this video on YouTube." })
      };
    }

    // Prefer an English track; otherwise fall back to whatever is available.
    var track =
      tracks.filter(function (t) {
        return (t.languageCode || "").indexOf("en") === 0;
      })[0] || tracks[0];

    if (!track || !track.baseUrl) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: "Found a caption track but it had no usable URL." })
      };
    }

    var captionRes = await getUrl(track.baseUrl);
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
