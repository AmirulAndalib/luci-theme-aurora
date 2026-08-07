import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── 共享渐进层 ──────────────────────────────────────────────────────────
test("the shared page-bg partial exists and both entries import it", () => {
  const partial = read("../src/media/_page-bg.css");
  assert.match(partial, /\.page-bg\s*\{/);
  assert.match(read("../src/media/main.css"), /@import "\.\/_page-bg\.css"/);
  assert.match(read("../src/media/login.css"), /@import "\.\/_page-bg\.css"/);
});

test("login.css no longer carries its own .login-bg rules, only the token mapping", () => {
  const login = read("../src/media/login.css");
  assert.doesNotMatch(login, /\.login-bg/);
  assert.match(login, /--page-bg:\s*var\(--login-bg\)/);
  assert.match(login, /--page-bg-lqip:\s*var\(--login-bg-lqip\)/);
});

test("the partial is pure mechanism: it consumes only the --page-bg pair", () => {
  const partial = read("../src/media/_page-bg.css");
  // No entry-specific tokens — each consumer maps its own pair, so the
  // shared sheet never drags admin tokens into login.css (or vice versa).
  assert.doesNotMatch(partial, /var\(--main-bg/);
  assert.doesNotMatch(partial, /var\(--login-bg/);
  // LQIP paints first, the full image fades in on ::after — the login page's
  // established progressive contract, now shared.
  assert.match(partial, /background-image:var\(--page-bg-lqip,var\(--page-bg\)\)/);
  assert.match(partial, /&\.full-loaded::after/);
});

test("sysauth.ut renders the shared layer and its loader reads --page-bg generically", () => {
  const ut = readFileSync(
    new URL("../../ucode/template/themes/aurora/sysauth.ut", import.meta.url),
    "utf8"
  );
  assert.match(ut, /class="page-bg"/);
  assert.doesNotMatch(ut, /login-bg/);
  assert.match(ut, /getComputedStyle\(bg\)\.getPropertyValue\('--page-bg'\)/);
});

// ── header.ut 条件渲染:未配置背景时功能不存在 ─────────────────────────
test("header.ut gates every main-bg artifact on struct_main_bg", () => {
  const ut = readFileSync(
    new URL("../../ucode/template/themes/aurora/header.ut", import.meta.url),
    "utf8"
  );
  // 共享 preload 助手:login/main 两处调用,data: URI 不 preload
  assert.match(ut, /function bg_preload_url/);
  assert.match(ut, /bg_preload_url\(tokens\.struct_login_bg\)/);
  assert.match(ut, /bg_preload_url\(tokens\.struct_main_bg\)/);
  // body 的 data-bg 属性与其 struct_main_bg 守卫在同一行模板上
  assert.match(ut, /!blank_page && tokens\.struct_main_bg[^\n]*data-bg/);
  assert.match(ut, /class="page-bg"/);
  // admin loader 与 sysauth 同款:读元素自身的 --page-bg
  assert.match(ut, /getComputedStyle\(bg\)\.getPropertyValue\('--page-bg'\)/);
});

// ── D 方案:frost 只许上顶栏+侧栏,卡片禁 blur,默认值只在 fallback ────
test("scheme D: frost is confined to the two chrome surfaces", () => {
  const mode = read("../src/media/_page-bg-mode.css");
  assert.match(mode, /body\[data-bg\]/);
  // backdrop-filter 恰好出现一次:header + sidebar 合用的那条规则
  assert.equal(mode.match(/backdrop-filter/g).length, 1);
  // 卡片规则存在且派生自 --surface(color-mix,无 blur)
  assert.match(mode, /\.cbi-section[^{]*\{[^}]*color-mix\(in_srgb,var\(--surface\)/);
  // 遮罩叠在大图层之上
  assert.match(mode, /page-bg::before/);
  assert.match(mode, /z-1/);
  // admin 的 token 映射也归 mode 文件:login.css 永不掺入 --main-bg
  assert.match(mode, /--page-bg:\s*var\(--main-bg\)/);
  assert.match(mode, /--page-bg-lqip:\s*var\(--main-bg-lqip\)/);
});

test("scheme D: the three tunables default only in var() fallbacks", () => {
  const mode = read("../src/media/_page-bg-mode.css");
  assert.match(mode, /var\(--main-bg-alpha,67%\)/);
  assert.match(mode, /var\(--main-bg-blur,20px\)/);
  assert.match(mode, /var\(--main-bg-scrim,20%\)/);
  // body 上不得声明默认(UCI 注入在 :root,body 层声明会遮蔽)
  assert.doesNotMatch(mode, /--main-bg-alpha:\s*67%/);
  assert.match(read("../src/media/main.css"), /@import "\.\/_page-bg-mode\.css"/);
  assert.doesNotMatch(read("../src/media/login.css"), /_page-bg-mode/);
});

test("reduced transparency restores opaque surfaces under a custom background", () => {
  const rt = read("../src/media/_reduced-transparency.css");
  assert.match(rt, /body\[data-bg\][^}]*--main-bg-alpha:\s*100%/s);
});

// 固定定位的 .page-bg 按 CSS 绘制顺序画在非 positioned 普通流内容之上——
// 登录页靠 .login-screen 的 relative 浮起,admin 侧必须同样把 #maincontent
// 提为 relative。负 z-index 不是出路:body 自身不透明背景会把层盖掉。
test("admin content is lifted above the fixed background layer", () => {
  const mode = read("../src/media/_page-bg-mode.css");
  assert.match(mode, /& #maincontent\s*\{[^}]*relative/);
});
