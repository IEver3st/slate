import { copyFileSync, appendFileSync, existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ffmpeg = process.env.SLATE_FFMPEG || "ffmpeg";
const jobDir = process.env.SLATE_JOB;
const encoder = process.env.SLATE_ENCODER || "libx264";
const gop = Number(process.env.SLATE_GOP || "60");
const deliverable = process.env.SLATE_EXPORT === "1";

function rewriteEncode(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-c:v" && args[i + 1] === "libx264") {
      i++;
      if (encoder === "h264_amf") {
        out.push("-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed", "-rc", "cqp", "-qp_i", "19", "-qp_p", "21", "-bf", "0", "-forced_idr", "1");
      } else if (encoder === "h264_nvenc") {
        out.push("-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "constqp", "-qp", "20", "-bf", "0", "-forced-idr", "1");
      } else if (encoder === "h264_qsv") {
        out.push("-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "20", "-bf", "0");
      } else {
        out.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode", "-crf", "20", "-bf", "0", "-sc_threshold", "0");
      }
      continue;
    }
    if (a === "-b:v") {
      i++;
      continue;
    }
    if (a === "-g") {
      i++;
      out.push("-g", String(gop), "-force_key_frames", `expr:gte(n,n_forced*${gop})`);
      continue;
    }
    out.push(a);
  }
  return out;
}

function fastPreviewMux(args: string[]): { skipped: true } | { args: string[] } | undefined {
  const inputs: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-i") inputs.push(args[i + 1]);
  }
  const outFile = args[args.length - 1];
  if (inputs.length !== 2 || !outFile || outFile.startsWith("-")) return undefined;
  const videoIn = inputs.find((f) => !f.toLowerCase().endsWith(".wav"));
  const wavIn = inputs.find((f) => f.toLowerCase().endsWith(".wav"));
  if (!videoIn || !wavIn || !existsSync(videoIn)) return undefined;
  const hasFilterOrTrim = args.some((a) => a === "-vf" || a === "-af" || a === "-filter_complex" || a === "-ss" || a === "-t" || a === "-to");
  if (hasFilterOrTrim) return undefined;
  // Preview splitSpan only reads video stream (0:v:0) and discards AAC audio (Slate mixes PCM directly from audio.wav).
  // Fast-path: if videoIn is already an MP4, link/copy directly without spawning ffmpeg or encoding AAC!
  if (videoIn.toLowerCase().endsWith(".mp4")) {
    try {
      rmSync(outFile, { force: true });
      try {
        linkSync(videoIn, outFile);
      } catch {
        copyFileSync(videoIn, outFile);
      }
      return { skipped: true };
    } catch {}
  }
  return { args: ["-hide_banner", "-loglevel", "error", "-y", "-i", videoIn, "-map", "0:v:0", "-c:v", "copy", "-an", outFile] };
}

function rewriteDeliverable(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-c:v" && args[i + 1] === "libx264") {
      i++;
      if (encoder === "h264_amf") {
        out.push("-c:v", "h264_amf", "-usage", "transcoding", "-quality", "quality", "-profile:v", "high", "-rc", "cqp", "-qp_i", "16", "-qp_p", "18", "-qp_b", "20", "-bf", "2");
      } else if (encoder === "h264_nvenc") {
        out.push("-c:v", "h264_nvenc", "-preset", "p6", "-profile:v", "high", "-rc", "constqp", "-qp", "17", "-bf", "2", "-spatial-aq", "1");
      } else if (encoder === "h264_qsv") {
        out.push("-c:v", "h264_qsv", "-preset", "slower", "-profile:v", "high", "-global_quality", "17", "-bf", "2");
      } else {
        out.push("-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high");
      }
      continue;
    }
    if (a === "-b:v") {
      i++;
      continue;
    }
    if (a === "-g") {
      out.push("-g", String(Number(args[i + 1]) * 2 || 120));
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function rewriteMux(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === "-b:a" ? "320k" : a));
}

const args = process.argv.slice(2);
const isEncode = args.includes("rawvideo") && args.includes("pipe:0");
const wav = args.find((a) => a.toLowerCase().endsWith(".wav"));
let finalArgs = deliverable ? (isEncode ? rewriteDeliverable(args) : rewriteMux(args)) : isEncode ? rewriteEncode(args) : args;
let skippedMux = false;

if (jobDir) {
  try {
    mkdirSync(jobDir, { recursive: true });
    if (!deliverable && !isEncode && wav) {
      copyFileSync(wav, join(jobDir, "audio.wav"));
      const fast = fastPreviewMux(args);
      if (fast && "skipped" in fast) skippedMux = true;
      else if (fast) finalArgs = fast.args;
    }
    appendFileSync(join(jobDir, "shim.log"), JSON.stringify(skippedMux ? ["fast-copy", ...args] : finalArgs) + "\n");
  } catch (e) {
    appendFileSync(join(jobDir, "shim.log"), `error ${String(e)}\n`);
  }
}

if (skippedMux) process.exit(0);

const proc = Bun.spawn([ffmpeg, ...finalArgs], { stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
process.exit(await proc.exited);
