import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const config = {
  entryPoints: ["src/bridge.js"],
  bundle: true,
  outfile: "dist/bridge.js",
  format: "iife",
  target: ["es2020"],
  minify: false,
  keepNames: true,
  sourcemap: "inline",
  platform: "browser",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  // bippy may not resolve in all cases — mark as external if not found
  logLevel: "warning",
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(config);
  const fs = await import("fs");
  const stat = fs.statSync("dist/bridge.js");
  console.log(`✔ dist/bridge.js (${(stat.size / 1024).toFixed(1)} KB)`);
}
