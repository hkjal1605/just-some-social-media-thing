import { describe, expect, test } from "bun:test";
import {
  deletePrefix,
  getObjectBytes,
  getObjectStream,
  headBucket,
  isKnownKey,
  presignGet,
  putObject,
  r2Key,
} from "../src";

describe("r2Key builders (doc 00 §5.5)", () => {
  test("shapes match the convention", () => {
    expect(r2Key.asset("b1", "a1", "mp3")).toBe("assets/b1/a1.mp3");
    expect(r2Key.render("b1", "r1", "tiktok")).toBe("renders/b1/r1_tiktok.mp4");
    expect(r2Key.longformSource("l1")).toBe("longforms/l1/source.mp4");
    expect(r2Key.longformClip("l1", "c1")).toBe("longforms/l1/clips/c1.mp4");
    expect(r2Key.campaignSource("cmp", "f1")).toBe("campaigns/cmp/source/f1.mp4");
    expect(r2Key.thumb("r1")).toBe("thumbs/r1.jpg");
  });

  test("isKnownKey gates presign namespaces", () => {
    expect(isKnownKey("renders/b/x.mp4")).toBe(true);
    expect(isKnownKey("../etc/passwd")).toBe(false);
    expect(isKnownKey("backups/pg/x.dump")).toBe(false);
  });
});

describe("memory driver (APP_ENV=test)", () => {
  test("put → get roundtrip", async () => {
    const data = new TextEncoder().encode("hello viral engine");
    const res = await putObject("assets/test/roundtrip.txt", data, "text/plain");
    expect(res.bytes).toBe(data.byteLength);
    const back = await getObjectBytes("assets/test/roundtrip.txt");
    expect(new TextDecoder().decode(back)).toBe("hello viral engine");
  });

  test("put stream body", async () => {
    const stream = new Response("streamed-bytes").body as ReadableStream<Uint8Array>;
    await putObject("assets/test/stream.txt", stream, "text/plain");
    const back = await getObjectBytes("assets/test/stream.txt");
    expect(new TextDecoder().decode(back)).toBe("streamed-bytes");
  });

  test("getObjectStream on missing key throws", async () => {
    expect(getObjectStream("assets/test/nope")).rejects.toThrow("no such key");
  });

  test("presignGet returns a URL-ish string", async () => {
    const url = await presignGet("assets/test/roundtrip.txt", 60);
    expect(url).toContain("assets/test/roundtrip.txt");
  });

  test("deletePrefix removes the namespace", async () => {
    await putObject("assets/wipe/1.txt", new Uint8Array([1]), "text/plain");
    await putObject("assets/wipe/2.txt", new Uint8Array([2]), "text/plain");
    await deletePrefix("assets/wipe/");
    expect(getObjectBytes("assets/wipe/1.txt")).rejects.toThrow();
  });

  test("headBucket is healthy in memory mode", async () => {
    expect(await headBucket()).toBe(true);
  });
});
