// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ENGLISH_MESSAGES,
  createUiAttachI18n,
  localizeDocument,
  translateWidgetLifecycleMessage,
} from "./i18n";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

describe("extension localization", () => {
  test("keeps lifecycle-only widget translations outside store-confirmed locale catalogs", () => {
    expect(translateWidgetLifecycleMessage("zh-CN", "in_page_widget_mark_resolved"))
      .toBe("标为已解决");
    expect(translateWidgetLifecycleMessage("zh_CN", "in_page_widget_reopen_annotation"))
      .toBe("重新打开批注 {label}");
    expect(translateWidgetLifecycleMessage("en-US", "in_page_widget_mark_resolved"))
      .toBeNull();
    expect(translateWidgetLifecycleMessage("zh-CN", "unknown"))
      .toBeNull();
  });

  test("ships complete English and Simplified Chinese Chrome locale catalogs", async () => {
    const [english, simplifiedChinese] = await Promise.all([
      readCatalog("en"),
      readCatalog("zh_CN"),
    ]);

    expect(Object.keys(english).toSorted()).toEqual(Object.keys(ENGLISH_MESSAGES).toSorted());
    expect(Object.keys(simplifiedChinese).toSorted()).toEqual(
      Object.keys(ENGLISH_MESSAGES).toSorted(),
    );
    expect(Object.fromEntries(
      Object.entries(english).map(([key, value]) => [key, value.message]),
    )).toEqual(ENGLISH_MESSAGES);
    expect(simplifiedChinese.add_elements?.message).toBe("添加元素");
    expect(simplifiedChinese.copy_for_agent?.message).toBe("复制给 Agent");
    expect(english.agent_handoff_copy_next_step?.message).toBe(
      "Paste the handoff into the text agent you want to use. MeanThis does not run page actions.",
    );
    expect(simplifiedChinese.agent_handoff_copy_next_step?.message).toBe(
      "请将 handoff 粘贴到你要使用的文本 Agent。MeanThis 不会执行页面操作。",
    );
    expect(english.agent_handoff_context_only_next_step?.message).toBe(
      "Paste the handoff, then tell the agent what you want it to do. MeanThis does not run page actions.",
    );
    expect(simplifiedChinese.agent_handoff_context_only_next_step?.message).toBe(
      "请粘贴 handoff，然后告诉 Agent 你希望它做什么。MeanThis 不会执行页面操作。",
    );
    expect(english.task?.message).toBe("Task note for selected element");
    expect(simplifiedChinese.task?.message).toBe("所选元素的任务说明");
    expect(english.session?.message).toBe("Selected elements");
    expect(simplifiedChinese.session?.message).toBe("所选元素");
    expect(english.remove_selected_element?.message).toBe("Remove selected element");
    expect(simplifiedChinese.remove_selected_element?.message).toBe("移除所选元素");
    expect(english.open_annotation_actions?.message).toBe("Open actions for annotation");
    expect(simplifiedChinese.open_annotation_actions?.message).toBe("打开标注操作");
    expect(english.annotation_details?.message).toBe("Show annotation details");
    expect(simplifiedChinese.annotation_details?.message).toBe("查看标注详情");
    expect(english.describe_change_help?.message).toBe("Write the result you want.");
    expect(simplifiedChinese.describe_change_help?.message).toBe("写下你希望得到的结果。");
    expect(english.layout_relationship_optional?.message).toBe("Use a task note shortcut (optional)");
    expect(simplifiedChinese.layout_relationship_optional?.message).toBe("使用任务说明快捷项（可选）");
    expect(english.copy_content_recovery?.message).toBe("Copy options");
    expect(simplifiedChinese.copy_content_recovery?.message).toBe("复制选项");
    expect(english.relation_help?.message).toBe(
      "A shortcut writes a task note only for the current task element. The reference element is not given its own task.",
    );
    expect(simplifiedChinese.relation_help?.message).toBe(
      "快捷项只为当前任务元素填写说明；参照元素不会因此获得独立任务。",
    );
    expect(english.relation_role_summary?.message).toBe(
      "Task element: {source} · Reference element: {reference}",
    );
    expect(simplifiedChinese.relation_role_summary?.message).toBe(
      "任务元素：{source} · 参照元素：{reference}",
    );
    expect(english.relation_applied_feedback?.message).toBe(
      "Task note added to {source}; {reference} is used only as a reference.",
    );
    expect(simplifiedChinese.relation_applied_feedback?.message).toBe(
      "说明已写入 {source}；{reference} 仅作为参照。",
    );
    expect(english.in_page_widget_create_invitation?.message).toBe(
      "Create connection invitation",
    );
    expect(simplifiedChinese.in_page_widget_create_invitation?.message).toBe(
      "创建连接邀请",
    );
    expect(english.in_page_widget_open_full_side_panel?.message).toBe(
      "Open full side panel",
    );
    expect(simplifiedChinese.in_page_widget_open_full_side_panel?.message).toBe(
      "打开完整侧栏",
    );
    expect(english.in_page_widget_disclosure_acknowledge_failed?.message).toBe(
      "MeanThis could not save your acknowledgement. Try again.",
    );
    expect(simplifiedChinese.in_page_widget_disclosure_acknowledge_failed?.message).toBe(
      "MeanThis 无法保存你的确认，请重试。",
    );
    expect(english.in_page_widget_copy_succeeded?.message).toContain("{count}");
    expect(simplifiedChinese.in_page_widget_copy_succeeded?.message).toContain("{count}");
    expect(english.in_page_widget_retry_clear?.message).toBe(
      "Retry clearing page annotations",
    );
    expect(simplifiedChinese.in_page_widget_retry_clear?.message).toBe(
      "重试清除页面标注",
    );
    expect(english.in_page_widget_clear_pending?.message).toBe(
      "Clearing page annotations is still pending. Retry to confirm completion.",
    );
    expect(simplifiedChinese.in_page_widget_clear_pending?.message).toBe(
      "页面标注仍在清除中。请重试以确认清除完成。",
    );
    expect(english.relationship?.message).toBe("Shortcut");
    expect(simplifiedChinese.relationship?.message).toBe("快捷项");
    expect(english.use_in_task_note?.message).toBe("Generate and fill");
    expect(simplifiedChinese.use_in_task_note?.message).toBe("生成并填入");
    expect(english.view_exact_handoff?.message).toBe("Preview copy content");
    expect(simplifiedChinese.view_exact_handoff?.message).toBe("预览复制内容");
    expect(english.saved_review_capture_details?.message).toBe("Capture details");
    expect(simplifiedChinese.saved_review_capture_details?.message).toBe("捕获详情");
    expect(english.advanced_attachment_data?.message).toBe("Developer diagnostics");
    expect(simplifiedChinese.advanced_attachment_data?.message).toBe("开发者诊断数据");
    expect(english.developer_diagnostics_help?.message).toBe(
      "Raw metadata and separate Markdown/JSON copies for debugging integrations.",
    );
    expect(simplifiedChinese.developer_diagnostics_help?.message).toBe(
      "用于调试集成的原始元数据，以及独立的 Markdown/JSON 副本。",
    );
    expect(english.page_access_limit?.message).toBe(
      "Keep this side panel open. After you select MeanThis in the toolbar, it refreshes automatically.",
    );
    expect(simplifiedChinese.page_access_limit?.message).toBe(
      "侧栏无需关闭；在工具栏中选择 MeanThis 后，侧栏会自动刷新。",
    );
    expect(english.page_access_enable_automatic?.message).toBe(
      "Enable automatic access to web pages",
    );
    expect(simplifiedChinese.page_access_enable_automatic?.message).toBe(
      "开启自动跟随普通网页",
    );
    expect(english.page_access_automatic_explanation?.message).toBe(
      "Chrome will keep MeanThis authorized for ordinary HTTP(S) pages. MeanThis captures only after you choose Add elements or another explicit capture action.",
    );
    expect(simplifiedChinese.page_access_automatic_explanation?.message).toBe(
      "Chrome 将持续授权 MeanThis 访问普通 HTTP(S) 页面；只有你选择“添加元素”或执行其他明确的捕捉操作后，MeanThis 才会捕捉内容。",
    );
    expect(english.page_access_automatic_denied?.message).toContain("not granted");
    expect(simplifiedChinese.page_access_automatic_denied?.message).toContain("未授予");
    expect(english.page_access_automatic_failed?.message).toContain("could not be enabled");
    expect(simplifiedChinese.page_access_automatic_failed?.message).toContain("无法开启");
    expect(english.page_access_automatic_not_ready?.message).toContain("still cannot access");
    expect(simplifiedChinese.page_access_automatic_not_ready?.message).toContain("仍无法访问");
    expect(english.first_capture_disclosure_heading?.message).toBe(
      "Before your first capture",
    );
    expect(english.first_capture_disclosure_intro?.message).toBe(
      "MeanThis creates references for elements you choose. Each reference may also include page and nearby context.",
    );
    expect(english.first_capture_disclosure_data?.message).toBe(
      "A selected reference can include the page URL and title; the canonical top-page-to-selected-frame origin/path route; element structure, accessibility facts, labels, styles, bounds, locator and replay evidence, selected text (including hidden descendant text), nearby text, your task notes, optional source anchors, and iframe origin/path boundaries.",
    );
    expect(english.first_capture_disclosure_diagnostics?.message).toBe(
      "If you turn on the optional one-shot private troubleshooting summary, it may include only replay result counts and coarse device, viewport, and touch classes. It does not include page content, addresses, exact dimensions, user agent, network or console data, screenshots, HAR, or debugger/CDP data. The option is off by default and applies only to the next capture. The private summary is copied only when you choose Copy summary; a connected local Agent may separately receive the disclosed coarse diagnostics.",
    );
    expect(english.first_capture_disclosure_local?.message).toBe(
      "Captures and session state stay in this browser profile. Copies leave only when you choose to copy, export, or connect the optional local agent bridge.",
    );
    expect(english.first_capture_disclosure_redaction?.message).toBe(
      "Agent-safe is the default and tries to redact likely sensitive text. Developer diagnostic keeps more route detail, and Full debug can retain recognized sensitive values. Screenshots and DOM snippets remain excluded; no mode guarantees that all sensitive information is removed.",
    );
    expect(english.first_capture_disclosure_receiver?.message).toBe(
      "Copy for agent writes the handoff text to your system clipboard; Export writes a local file. Your browser, operating system, and applications that can access or receive those copies control them afterward. While the optional local agent bridge is connected, Agent-safe context refreshes automatically over that local connection.",
    );
    expect(english.first_capture_disclosure_first_trial?.message).toBe(
      "For your first trial, use a non-sensitive, unauthenticated HTTP(S) page.",
    );
    expect(english.acknowledge_and_return?.message).toBe(
      "I understand — return to Add elements",
    );
    expect(english.not_now?.message).toBe("Not now");
    expect(english.review_data_disclosure?.message).toBe("Review data disclosure");
    expect(simplifiedChinese.first_capture_disclosure_heading?.message).toBe("首次捕获前");
    expect(simplifiedChinese.first_capture_disclosure_intro?.message).toBe(
      "MeanThis 只为你选择的元素创建引用；引用也可能包含页面信息和附近上下文。",
    );
    expect(simplifiedChinese.first_capture_disclosure_data?.message).toBe(
      "所选引用可能包含页面 URL 与标题、从顶层页面到所选 frame 的规范化 origin/path route，以及元素结构、无障碍事实、标签、样式、边界、定位与 replay 证据、所选文本（包括隐藏后代文本）、附近文本、你的任务说明、可选 source anchor 与 iframe origin/path boundary。",
    );
    expect(simplifiedChinese.first_capture_disclosure_diagnostics?.message).toBe(
      "如果你打开可选的一次性私有排障摘要，它只会包含 replay 结果计数及粗粒度的设备、视口和触控类别；不包含页面内容、地址、精确尺寸、user agent、网络或 console 数据、截图、HAR 或 debugger/CDP 数据。该选项默认关闭，只对下一次捕获有效。只有选择“复制摘要”才会复制私有摘要；已连接的本地 Agent 仍可能通过另行披露并授权的通道接收这些粗粒度诊断。",
    );
    expect(simplifiedChinese.first_capture_disclosure_local?.message).toBe(
      "捕获内容和会话状态保存在此浏览器配置中；只有当你选择复制、导出或连接可选的本地 Agent 桥接时，副本才会离开。",
    );
    expect(simplifiedChinese.first_capture_disclosure_redaction?.message).toBe(
      "“Agent 安全”是默认模式，会尝试脱敏可能的敏感文本；“开发者诊断”会保留更多 route detail，“完整调试”可以保留已识别的敏感值。截图和 DOM 片段仍不包含；任何模式都不能保证清除全部敏感信息。",
    );
    expect(simplifiedChinese.first_capture_disclosure_receiver?.message).toBe(
      "“复制给 Agent”会把 handoff 文本写入系统剪贴板；导出会写入本地文件。之后，这些副本由浏览器、操作系统以及能够访问或接收它们的应用管理。连接可选的本地 Agent 桥接后，“Agent 安全”上下文会通过该本地连接自动刷新。",
    );
    expect(simplifiedChinese.first_capture_disclosure_first_trial?.message).toBe(
      "首次试用请使用不含敏感信息、无需登录的 HTTP(S) 页面。",
    );
    expect(simplifiedChinese.acknowledge_and_return?.message).toBe(
      "我已了解，返回添加元素",
    );
    expect(simplifiedChinese.not_now?.message).toBe("暂不");
    expect(simplifiedChinese.review_data_disclosure?.message).toBe("查看数据披露");
    expect(english.in_page_widget_collect_basic_diagnostics_label?.message).toBe(
      "Add a private troubleshooting summary to the next capture",
    );
    expect(english.in_page_widget_collect_basic_diagnostics_help?.message).toBe(
      "Includes replay result counts and coarse device classes. No page content, address, exact size, user agent, network, console, screenshot, or HAR. Used once. This summary is copied only when you choose Copy summary; a connected local Agent may separately receive the disclosed coarse diagnostics.",
    );
    expect(simplifiedChinese.in_page_widget_collect_basic_diagnostics_label?.message).toBe(
      "为下一次捕获添加私有排障摘要",
    );
    expect(simplifiedChinese.in_page_widget_collect_basic_diagnostics_help?.message).toBe(
      "仅包含 replay 结果计数及粗粒度设备类别；不含页面内容、地址、精确尺寸、user agent、网络、console、截图或 HAR。仅使用一次；只有选择“复制摘要”才会复制。已连接的本地 Agent 仍可能通过另行披露并授权的 Agent-safe 通道接收这些粗粒度诊断。",
    );
    expect(english.in_page_widget_private_debug_summary_not_copied?.message)
      .toBe("Not copied yet");
    expect(simplifiedChinese.in_page_widget_private_debug_summary_not_copied?.message)
      .toBe("尚未复制");
  });

  test("uses browser messages and safely fills named runtime values", () => {
    const i18n = createUiAttachI18n({
      getMessage: (key) => ({
        copied_elements_for_agent: "已复制 {count} 个元素给 Agent。",
      })[key] ?? "",
      getUILanguage: () => "zh-CN",
    });

    expect(i18n.language).toBe("zh-CN");
    expect(i18n.t("copied_elements_for_agent", { count: 3 })).toBe(
      "已复制 3 个元素给 Agent。",
    );
    expect(i18n.t("add_elements")).toBe("Add elements");
  });

  test("localizes static text, placeholders, accessible names, and document language", () => {
    document.body.innerHTML = `
      <button data-i18n="add_elements">Add elements</button>
      <textarea data-i18n-placeholder="intent_placeholder" placeholder="Describe the result you want"></textarea>
      <section data-i18n-aria-label="captured_elements_aria" aria-label="Captured elements"></section>
    `;
    const i18n = createUiAttachI18n({
      getMessage: (key) => ({
        add_elements: "添加元素",
        intent_placeholder: "描述你想要的结果",
        captured_elements_aria: "已捕获的元素",
      })[key] ?? "",
      getUILanguage: () => "zh-CN",
    });

    localizeDocument(document, i18n);

    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.querySelector("button")?.textContent).toBe("添加元素");
    expect(document.querySelector("textarea")?.placeholder).toBe("描述你想要的结果");
    expect(document.querySelector("section")?.getAttribute("aria-label")).toBe("已捕获的元素");
  });
});

async function readCatalog(locale: string): Promise<Record<string, { message: string }>> {
  return JSON.parse(await readFile(
    resolve(workspaceRoot, `apps/extension-mv3/public/_locales/${locale}/messages.json`),
    "utf8",
  )) as Record<string, { message: string }>;
}
