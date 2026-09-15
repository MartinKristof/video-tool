"use client";

import React, { useState, useEffect } from "react";
import Icon from "@/components/ui/Icon";

const FILM_FACTS = [
  "The first film ever made was 'Roundhay Garden Scene' in 1888 — it's only 2.11 seconds long.",
  "A single frame of Toy Story took 4-13 hours to render back in 1995.",
  "The Wilhelm Scream has been used in over 400 films and TV shows since 1951.",
  "24fps became the standard because it was the minimum speed for audio sync in early talkies.",
  "The Lord of the Rings trilogy used 48,000 pieces of armor and 10,000 arrows.",
  "Hitchcock's 'Rope' (1948) was designed to look like one continuous shot using hidden cuts.",
  "Stanley Kubrick used NASA lenses for candlelit scenes in 'Barry Lyndon' (1975).",
  "Motion blur in film happens naturally — without it, animation looks uncanny.",
  "The first CGI character in a film was the stained glass knight in 'Young Sherlock Holmes' (1985).",
  "Pixar's 'Monsters, Inc.' had to simulate 2.3 million individual hairs on Sulley.",
  "The 180-degree shutter rule: shutter speed = 1/(2x frame rate) for natural motion blur.",
  "A 'Dutch angle' tilts the camera to create unease — popularized in German Expressionist cinema.",
  "Wes Anderson's signature centered framing is called 'planimetric composition.'",
  "The Kuleshov Effect proves that editing context changes how we interpret an actor's expression.",
  "IMAX film frames are 70mm wide — 10x the area of standard 35mm film.",
  "The 'magic hour' for filming is the 20-30 minutes after sunrise and before sunset.",
  "Foley artists recreate everyday sounds — footsteps on gravel are often crushed cornstarch.",
  "Buster Keaton did his own stunts, including a house facade falling on him in 'Steamboat Bill, Jr.'",
  "The Mandalorian pioneered virtual production using massive LED walls instead of green screens.",
  "Eadweard Muybridge settled a bet about galloping horses — and accidentally invented motion pictures.",
  "Arnold Schwarzenegger was paid roughly $21,429 per word in Terminator 2 — he only spoke 700 words.",
  "The snow in The Shining's hedge maze was actually 900 tons of salt and crushed Styrofoam.",
  "E.T.'s face was modeled after a combination of poet Carl Sandburg, Albert Einstein, and a pug dog.",
  "Every ping-pong ball in Forrest Gump's tournament scenes is entirely CGI.",
  "Daniel Radcliffe went through approximately 160 pairs of prop glasses filming eight Harry Potter movies.",
  "The stabbing sound in Psycho's shower scene was created by plunging a knife into a casaba melon.",
  "Tom Cruise trained to hold his breath underwater for six minutes for Mission: Impossible - Rogue Nation.",
  "Monty Python used coconuts for horse hooves in Holy Grail because the budget was too small for horses.",
  "The Lion King's wildebeest stampede took Disney's CG animators three years for 2.5 minutes of footage.",
  "Jurassic Park has only 15 minutes of actual dinosaur footage in its entire 127-minute runtime.",
  "Heath Ledger locked himself in a hotel room for a month to develop the Joker's psychology and voice.",
  "In Cast Away, production shut down for a year so Tom Hanks could lose 50 pounds and grow his hair.",
  "The liquid metal T-1000 effects in Terminator 2 took 35 CGI animators ten months for five minutes.",
  "The Big Lebowski script uses the word 'dude' 160 times, and the F-word 292 times.",
  "The Millennium Falcon was redesigned last-minute because it looked like the ship from Space: 1999.",
  "In Gravity, Sandra Bullock spent up to 10 hours a day inside a massive 'lightbox' to simulate space.",
  "Akira (1988) had over 2,300 shades of color — many created specifically for the film.",
  "Toy Story (1995) rendered for a total of 800,000 machine-hours across Pixar's render farm.",
  "The opening shot of La La Land is a single take that took 4 days to choreograph.",
];

export default function GeneratingOverlay({ visible }: { visible: boolean }) {
  const [factIndex, setFactIndex] = useState(() => Math.floor(Math.random() * FILM_FACTS.length));

  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      setFactIndex((prev) => (prev + 1) % FILM_FACTS.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "rgba(5,5,8,0.88)",
        backdropFilter: "blur(18px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
        padding: 40,
      }}
    >
      {/* Animated film reel */}
      <div style={{ position: "relative", width: 120, height: 120 }}>
        <svg
          width="120"
          height="120"
          viewBox="0 0 120 120"
          style={{ animation: "vt-spin 8s linear infinite" }}
        >
          <defs>
            <radialGradient id="gen-g">
              <stop offset="0%" stopColor="oklch(0.88 0.22 124)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="oklch(0.88 0.22 124)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="60" cy="60" r="56" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
          <circle
            cx="60"
            cy="60"
            r="56"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
            strokeDasharray="20 340"
          />
          <circle
            cx="60"
            cy="60"
            r="40"
            fill="none"
            stroke="rgba(255,255,255,0.15)"
            strokeWidth="0.5"
            strokeDasharray="4 4"
          />
          {[0, 60, 120, 180, 240, 300].map((a) => {
            const r = 48;
            const x = 60 + Math.cos((a * Math.PI) / 180) * r;
            const y = 60 + Math.sin((a * Math.PI) / 180) * r;
            return (
              <circle key={a} cx={x} cy={y} r="4" fill="rgba(255,255,255,0.2)" />
            );
          })}
          <circle cx="60" cy="60" r="8" fill="var(--accent)" />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: -20,
            background: "radial-gradient(circle, oklch(0.88 0.22 124 / 0.3), transparent 60%)",
            filter: "blur(20px)",
            pointerEvents: "none",
            zIndex: -1,
          }}
        />
      </div>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.4, marginBottom: 6 }}>
          Generating animation
        </div>
        <div
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--text-2)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            justifyContent: "center",
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--accent)",
              animation: "vt-pulse 1.4s infinite",
            }}
          />
          Code is streaming into the editor...
        </div>
      </div>

      {/* Trivia card */}
      <div
        style={{
          maxWidth: 440,
          padding: 18,
          background: "var(--bg-2)",
          border: "0.5px solid var(--line-2)",
          borderRadius: "var(--r-md)",
          boxShadow: "var(--sh-panel)",
        }}
      >
        <div
          className="mono cap"
          style={{
            color: "var(--accent)",
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon name="movie" size={12} /> Did you know?
        </div>
        <div
          key={factIndex}
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--text-0)",
            animation: "vt-glitch-in 400ms ease",
          }}
        >
          {FILM_FACTS[factIndex]}
        </div>
        <div style={{ display: "flex", gap: 3, marginTop: 12 }}>
          {FILM_FACTS.slice(0, 8).map((_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: 2,
                background: i === factIndex % 8 ? "var(--accent)" : "var(--bg-4)",
                borderRadius: 1,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
