// netlify/functions/fetch-captions.js
//
// Fetches auto-generated (or uploaded) YouTube captions for a given video
// and returns them as plain text. This runs server-side because browsers
// cannot fetch YouTube's caption files directly (CORS).
//
// IMPORTANT — this uses YouTube's public caption track data embedded in the
// video page, not an official API. YouTube does not guarantee this format
// stays stable. If this ever silently stops working, that's almost
// certainly why — check for YouTube changing the page structure.
//
// No external npm dependencies — uses only Node's built-in https module,
// so no package.json / install step is needed for this function to deploy.

const https = require("https");

function fetchUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchUrl(res.headers.location, redirects + 1));
          return;
        }
        var data = "";
        res.on("data", function (chunk) {
          data += chunk;
        });
        res.on("end", function () {
          resolve(data);
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

    var pageHtml = await fetchUrl("https://www.youtube.com/watch?v=" + videoId);

    var match = pageHtml.match(/"captionTracks":(\[.*?\])/);
    if (!match) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ error: "No captions found for this video. It may not have captions enabled, or the video may be private/restricted." })
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

    var captionXml = await fetchUrl(track.baseUrl);
    var textMatches = captionXml.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];

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
