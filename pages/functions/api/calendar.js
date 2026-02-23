export async function onRequestGet(context) {
  const ICS_URL =
    context.env.GOOGLE_CALENDAR_ICS ||
    "https://calendar.google.com/calendar/ical/0b1f47c11109dadca46ff2f9403ce982edfe143be30d4555bc0a895174c67b8a%40group.calendar.google.com/public/basic.ics";

  try {
    const res = await fetch(ICS_URL, {
      cf: {
        cacheTtl: 600,
        cacheEverything: true
      }
    });

    if (!res.ok) {
      return new Response("Failed to load calendar", { status: 500 });
    }

    const text = await res.text();

    return new Response(text, {
      headers: {
        "Content-Type": "text/calendar",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600"
      }
    });
  } catch (err) {
    return new Response("Calendar unavailable", { status: 500 });
  }
}