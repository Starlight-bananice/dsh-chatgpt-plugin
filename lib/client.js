window.__ModuleLoader__.load({
	id: "@bananiceee/dsh-chatgpt-provider",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/Card.tsx
		/**
		* The Models-page card for the ChatGPT provider.
		*
		* It renders inside the provider card the Models page already draws for this
		* plugin's directory row: the page dispatches its `settings.models.provider-card`
		* extension area with the row's namespace as the key, and this component
		* answers for `chatgpt`.
		*
		* Deliberately self-contained. It imports no harness client package for values
		* (the bundle-purity rule forbids it) and describes the props it receives
		* structurally rather than from a package's type declarations, because the
		* running application ships compiled bundles with no declarations and its API
		* surface may be newer than any checkout on the machine. React is the only
		* runtime import, and the page already provides it.
		*
		* @module dsh-chatgpt-provider/client/card
		*/
		/**
		* Call one API endpoint and parse its JSON reply.
		*
		* This never rejects. A transport failure is the most likely thing to happen in
		* practice (the host restarted, the port moved), and letting it escape would
		* leave the effect's promise unhandled with no way for the card to learn what
		* went wrong — so every failure becomes an `error` field the render path
		* already knows how to display.
		*/
		async function request(path, init) {
			let response;
			try {
				response = await fetch(`/chatgpt/api/${path}`, {
					headers: { "content-type": "application/json" },
					...init
				});
			} catch (error) {
				return { error: `could not reach the host: ${error instanceof Error ? error.message : String(error)}` };
			}
			let text = "";
			try {
				text = await response.text();
			} catch {}
			try {
				return JSON.parse(text);
			} catch {
				return { error: `unexpected reply (HTTP ${String(response.status)}): ${text.slice(0, 200)}` };
			}
		}
		/** Fetch the status document. */
		function callApi(path, init) {
			return request(path, init);
		}
		/** How often an unsettled attempt is polled. */
		const POLL_MS = 1500;
		/**
		* Render the ChatGPT sign-in card.
		* @param props - the slot's composed props, of which `t` is used.
		* @returns the card's element tree.
		*/
		function ChatGptCard({ t }) {
			const [status, setStatus] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [probe, setProbe] = (0, react.useState)(void 0);
			const [probing, setProbing] = (0, react.useState)(false);
			const openedUrl = (0, react.useRef)(void 0);
			const refresh = (0, react.useCallback)(async () => {
				const next = await callApi("status");
				if (next.error !== void 0) setError(next.error);
				else setStatus(next);
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const attempt = status?.attempt;
			const pending = attempt !== void 0 && (attempt.state === "waiting" || attempt.state === "exchanging");
			(0, react.useEffect)(() => {
				if (!pending) return void 0;
				const timer = setInterval(() => {
					refresh();
				}, POLL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [pending, refresh]);
			(0, react.useEffect)(() => {
				const url = attempt?.url;
				if (url === void 0 || openedUrl.current === url) return;
				openedUrl.current = url;
				window.open(url, "_blank", "noopener,noreferrer");
			}, [attempt?.url]);
			const start = (0, react.useCallback)(async (accountId) => {
				setBusy(true);
				setError(void 0);
				openedUrl.current = void 0;
				try {
					const next = await callApi("signin", {
						method: "POST",
						body: JSON.stringify(accountId === void 0 ? {} : { accountId })
					});
					if (next.error !== void 0) setError(next.error);
					await refresh();
				} finally {
					setBusy(false);
				}
			}, [refresh]);
			const cancel = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					await callApi("cancel", {
						method: "POST",
						body: "{}"
					});
					await refresh();
				} finally {
					setBusy(false);
				}
			}, [refresh]);
			const signOut = (0, react.useCallback)(async (accountId) => {
				setBusy(true);
				try {
					const next = await callApi("signout", {
						method: "POST",
						body: JSON.stringify({ accountId })
					});
					if (next.revokeError !== void 0) setError(`${t("revokeWarning")}${next.revokeError}`);
					await refresh();
				} finally {
					setBusy(false);
				}
			}, [refresh, t]);
			const select = (0, react.useCallback)(async (accountId) => {
				setBusy(true);
				try {
					const next = await callApi("select", {
						method: "POST",
						body: JSON.stringify({ accountId })
					});
					if (next.error !== void 0) setError(next.error);
					else setStatus(next);
				} finally {
					setBusy(false);
				}
			}, []);
			const runProbe = (0, react.useCallback)(async () => {
				setProbing(true);
				setProbe(void 0);
				const result = await request("selftest", {
					method: "POST",
					body: "{}"
				});
				setProbe(result.error !== void 0 && result.ok !== false ? {
					ok: false,
					error: result.error
				} : result);
				setProbing(false);
			}, []);
			if (status === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "cgpt-root",
				children: error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cgpt-muted",
					children: t("loading")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cgpt-error",
					children: error
				})
			});
			if (status.credentialsMissing) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "cgpt-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cgpt-error",
					children: t("noCredentials")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cgpt-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cgpt-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cgpt-title",
							children: t("title")
						}), status.planEnabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cgpt-muted",
							children: ["· ", t("usingPlan")]
						})]
					}),
					status.accounts.length === 0 && !pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cgpt-muted",
						children: t("intro")
					}),
					status.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cgpt-account",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							account.email ?? account.subject,
							account.id === status.activeAccountId && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cgpt-muted",
								children: [" · ", t("active")]
							}),
							!account.planEnabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cgpt-muted",
								children: [" · ", t("noPlan")]
							})
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cgpt-row",
							children: [
								account.id !== status.activeAccountId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cgpt-button",
									disabled: busy,
									onClick: () => {
										select(account.id);
									},
									children: t("use")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cgpt-button",
									disabled: busy,
									onClick: () => {
										start(account.id);
									},
									children: t("reauthorize")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cgpt-button",
									disabled: busy,
									onClick: () => {
										signOut(account.id);
									},
									children: t("signOut")
								})
							]
						})]
					}, account.id)),
					pending ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cgpt-stack",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: attempt.state === "exchanging" ? t("exchanging") : attempt.message ?? t("waiting") }),
							attempt.url !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cgpt-muted",
								children: [t("fallback"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: "cgpt-link",
									href: attempt.url,
									target: "_blank",
									rel: "noopener noreferrer",
									children: t("fallbackLink")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "cgpt-row",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cgpt-button",
									disabled: busy,
									onClick: () => {
										cancel();
									},
									children: t("cancel")
								})
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cgpt-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cgpt-button cgpt-primary",
								disabled: busy,
								onClick: () => {
									start();
								},
								children: status.accounts.length === 0 ? t("continue") : t("different")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								className: "cgpt-button",
								href: "https://chatgpt.com/settings/usage",
								target: "_blank",
								rel: "noopener noreferrer",
								children: t("manageUsage")
							}),
							status.signedIn && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cgpt-button",
								disabled: busy || probing,
								onClick: () => {
									runProbe();
								},
								children: t("test")
							})
						]
					}),
					probing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cgpt-muted",
						children: t("testing")
					}),
					probe !== void 0 && (probe.ok ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "cgpt-muted",
						children: [
							t("testOk"),
							probe.model,
							probe.text !== void 0 && probe.text !== "" ? ` · ${JSON.stringify(probe.text)}` : "",
							probe.usage !== void 0 ? ` · ${String(probe.usage.inputTokens)} in / ${String(probe.usage.outputTokens)} out` : ""
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "cgpt-error",
						children: [t("testFail"), probe.error ?? "unknown error"]
					})),
					attempt?.state === "failed" && attempt.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cgpt-error",
						children: attempt.error
					}),
					attempt?.state === "completed" && attempt.message !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cgpt-muted",
						children: attempt.message
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cgpt-error",
						children: error
					})
				]
			});
		}
		//#endregion
		//#region src/client/Section.tsx
		/**
		* The dedicated ChatGPT settings page.
		*
		* This is the plugin's own entry in the Settings sidebar, independent of the
		* Models page. It exists because the Models page renders a provider row only
		* for a provider whose settings namespace the Host actually serves, and joins
		* that row against the settings mirror — so a provider whose namespace failed
		* to register has no row, no card, and no visible sign that anything is wrong.
		* A page of this plugin's own has no such dependency: it talks to the plugin's
		* own HTTP surface, which is registered independently of settings.
		*
		* @module dsh-chatgpt-provider/client/section
		*/
		/**
		* Render the ChatGPT settings page.
		* @param props - the seat's composed props, of which `t` is used.
		* @returns the page's element tree.
		*/
		function ChatGptSection({ t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cgpt-page",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "cgpt-pageTitle",
						children: t("nav")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cgpt-pageLede",
						children: t("pageLede")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChatGptCard, { t })
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Locale dictionaries for the ChatGPT card.
		*
		* `zh` is the key-set source of truth and `en` is kept complete against it, the
		* convention the other client plugins in this application follow. The namespace
		* string is also what the slot registration passes as `locale`, which is what
		* synthesizes the component's `t` seat.
		*
		* @module dsh-chatgpt-provider/client/locales
		*/
		/** This card's locale namespace. */
		const NS = "chatgpt-provider";
		const zh = {
			"nav": "ChatGPT",
			"pageLede": "用你的 ChatGPT 账号登录，即可把 ChatGPT 方案（Plus / Pro）的模型当作一个普通 provider 使用。登录凭据保存在 Harness 的凭据文档里；这里也可以切换账号、重新授权、退出登录，或发一个真实的小请求测试连通性。",
			"title": "使用你的 ChatGPT 方案",
			"usingPlan": "正在使用 ChatGPT 方案",
			"intro": "在此应用中完成符合条件的 AI 请求，用量计入你的 ChatGPT 方案或额度余额。",
			"active": "当前",
			"noPlan": "未授予方案用量",
			"use": "使用",
			"reauthorize": "重新授权",
			"signOut": "退出登录",
			"cancel": "取消",
			"continue": "使用 ChatGPT 继续登录",
			"different": "使用其他 ChatGPT 账号",
			"manageUsage": "管理用量",
			"waiting": "等待浏览器完成登录…",
			"exchanging": "正在完成登录…",
			"fallback": "如果没有自动打开窗口，",
			"fallbackLink": "点此继续登录",
			"loading": "正在读取 ChatGPT 登录状态…",
			"noCredentials": "此部署未挂载凭据服务，ChatGPT 登录无处保存。",
			"revokeWarning": "已在本地退出登录，但未能撤销 ChatGPT 会话：",
			"test": "测试连接",
			"testing": "正在发送一个真实请求…",
			"testOk": "连通正常 · ",
			"testFail": "测试失败 · "
		};
		const en = {
			"nav": "ChatGPT",
			"pageLede": "Sign in with your ChatGPT account to use ChatGPT plan (Plus / Pro) models as an ordinary provider. Credentials are stored in the harness credential document; from here you can also switch accounts, reauthorize, sign out, or send one small real request to check connectivity.",
			"title": "Use your ChatGPT plan",
			"usingPlan": "Using ChatGPT plan",
			"intro": "Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.",
			"active": "active",
			"noPlan": "plan usage not granted",
			"use": "Use",
			"reauthorize": "Reauthorize",
			"signOut": "Sign out",
			"cancel": "Cancel",
			"continue": "Continue with ChatGPT",
			"different": "Use a different ChatGPT account",
			"manageUsage": "Manage usage",
			"waiting": "Waiting for the browser to finish…",
			"exchanging": "Finishing the sign-in…",
			"fallback": "If no window opened, ",
			"fallbackLink": "continue signing in here",
			"loading": "Loading ChatGPT sign-in state…",
			"noCredentials": "This deployment mounts no credential service, so a ChatGPT sign-in has nowhere to be stored.",
			"revokeWarning": "Signed out locally, but the ChatGPT session could not be revoked: ",
			"test": "Test",
			"testing": "Sending one real request…",
			"testOk": "Working · ",
			"testFail": "Test failed · "
		};
		//#endregion
		//#region src/client/styles.ts
		/**
		* The card's stylesheet.
		*
		* Injected as a plain `<style>` element rather than imported as a CSS module:
		* the bundle-purity rules reject value imports across plugin packages, and a
		* stylesheet that ships with the bundle would otherwise need the host's CSS
		* pipeline. Class names are prefixed `cgpt-` to stay collision-free, and colors
		* come from the application's own CSS variables with literal fallbacks so the
		* card matches whichever theme is active.
		*
		* @module dsh-chatgpt-provider/client/styles
		*/
		/** Class name prefix for this card. */
		const P = "cgpt";
		/** The stylesheet this card installs once. */
		const STYLES = `
.${P}-page { display: flex; flex-direction: column; gap: 10px; max-width: 46rem; }
.${P}-pageTitle { margin: 0; font-size: 16px; font-weight: 600; }
.${P}-pageLede {
  margin: 0; font-size: 13px; line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
}
.${P}-root { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.${P}-head { display: flex; align-items: baseline; gap: 6px; }
.${P}-title { font-weight: 600; }
.${P}-muted { color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.${P}-error { color: var(--dsw-alias-label-error, #c0392b); white-space: pre-wrap; }
.${P}-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${P}-stack { display: flex; flex-direction: column; gap: 6px; }
.${P}-account {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));
  border-radius: 6px;
}
.${P}-button {
  padding: 5px 10px; border-radius: 6px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.45));
  background: transparent; color: inherit; text-decoration: none; line-height: 1.5;
}
.${P}-button:disabled { opacity: 0.5; cursor: default; }
.${P}-button:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary, currentColor); }
.${P}-button.${P}-primary {
  background: var(--dsw-alias-bg-inverted, #000);
  color: var(--dsw-alias-label-inverted, #fff);
  border-color: var(--dsw-alias-bg-inverted, #000);
}
.${P}-link { color: inherit; text-decoration: underline; word-break: break-all; }
`;
		/** Install the stylesheet once, returning its remover. */
		function installStyles() {
			const element = document.createElement("style");
			element.dataset["dshChatgptProvider"] = "";
			element.textContent = STYLES;
			document.head.append(element);
			return () => {
				element.remove();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser entry for the ChatGPT provider plugin.
		*
		* It contributes one surface: the extension area inside this provider's card on
		* Settings → Models. The Models page dispatches
		* `settings.models.provider-card` with the row's settings namespace as the key,
		* so registering under `chatgpt` puts the sign-in controls exactly where a user
		* looks for a provider that needs an account.
		*
		* The `ctx` face is declared structurally, matching the runtime services rather
		* than a package's declarations — the shipped application has no `.d.ts` for
		* its client packages, and describing what is actually used keeps this entry
		* building against any version that provides `slots`, `locale`, and `effect`.
		*
		* @module dsh-chatgpt-provider/client
		*/
		/** The Models-page extension area this card also occupies. */
		const SLOT = "settings.models.provider-card";
		/** The Settings-sidebar seat this plugin's own page occupies. */
		const SECTION_SLOT = "settings.section";
		/**
		* The key the Models page dispatches with.
		*
		* It must equal the directory entry's `settingsNs`, which is this plugin's
		* profile entry id — not a name of the plugin's own choosing. A mismatch is
		* silent: the page dispatches one key, nothing is registered under it, and the
		* extension area simply renders nothing.
		*/
		const KEY = "dsh-chatgpt-provider";
		/**
		* Where this plugin's page sits in the Settings sidebar. The shipped pages use
		* low orders and the sibling plugin's page uses 40, so this lands after them.
		*/
		const SECTION_ORDER = 45;
		const inject = ["slots", "locale"];
		/** Install the stylesheet, the dictionaries, and the provider-card extension. */
		function apply(ctx) {
			ctx.effect(installStyles, "dsh-chatgpt-provider: styles");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-chatgpt-provider: locale");
			ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				key: KEY,
				locale: NS
			}, ChatGptCard));
			ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
				name: SECTION_SLOT,
				id: "chatgpt",
				order: SECTION_ORDER,
				label: () => ctx.locale.bind(NS)("nav"),
				locale: NS
			}, ChatGptSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map