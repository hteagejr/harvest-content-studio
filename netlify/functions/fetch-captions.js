// netlify/functions/fetch-captions.js
//
// Fetches YouTube captions/transcripts using the "youtube-caption-extractor"
// npm package (see package.json alongside this file) instead of a
// hand-written scrape of YouTube's page/API. This package is actively
// maintained specifically to track YouTube's changes — it tries several
// internal client types (ios, android_vr, mweb, etc.) in sequence and
// falls back automatically if one stops working, which is exactly the kind
// of breakage a hand-rolled single-method approach kept hitting.
//
// IMPORTANT — this is still fundamentally an unofficial method (YouTube has
// no public captions API). It can still fail if YouTube blocks ALL client
// types at once, or for a genuinely private/restricted video. "Paste the
// transcript manually" remains the fallback in the app UI either way.

const { getSubtitles } = require("youtube-caption-extractor");

function extractVideoId(url) {
  var m = (url || "").match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
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

    var subtitles;
    try {
      subtitles = await getSubtitles({ videoID: videoId, lang: "en" });
    } catch (libErr) {
      var msg = (libErr && libErr.message) || "";
      if (/429|rate.?limit/i.test(msg)) {
        return {
          statusCode: 429,
          headers: headers,
          body: JSON.stringify({ error: "YouTube is rate-limiting requests from our server right now. This isn't about your video — try again in a few minutes, or paste the transcript manually for now." })
        };
      }
      if (/unavailable|private|removed/i.test(msg)) {
        return {
          statusCode: 404,
          headers: headers,
          body: JSON.stringify({ error: "YouTube says this video is unavailable, private, or removed. Please check the link, or paste the transcript manually." })
        };
      }
      return {
        statusCode: 502,
        headers: headers,
        body: JSON.stringify({ error: "Couldn't reach this video on YouTube after trying several methods. Please try again shortly, or paste the transcript manually.\n\nDetails: " + msg })
      };
    }

    if (!subtitles || !subtitles.length) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ error: "No captions/auto-captions are available for this video on YouTube." })
      };
    }

    var transcript = subtitles
      .map(function (s) {
        return (s.text || "").trim();
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
      body: JSON.stringify({ transcript: transcript, language: "en" })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: "Something went wrong fetching captions: " + (err && err.message ? err.message : "unknown error") })
    };
  }
};
