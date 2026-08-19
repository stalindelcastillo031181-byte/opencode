import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  setupTimeline,
  toolPart,
  userMessage,
  userText,
} from "../performance/timeline-stability/fixture"

const hostname = "djqn10n.bx.internal.cloudapp.net"
const repository = "stalindelcastillo031181-byte/magenta-ia-studio"
const longUrl =
  "https://example.com/workspaces/djqn10n.bx.internal.cloudapp.net/stalindelcastillo031181-byte/magenta-ia-studio/node_modules/package/index.ts?branch=agent%2Fasync-attachments-final&execution=1234567890"
const longToken = "mobile-overflow-token-".repeat(80)

function overflowMessages() {
  const user = userMessage([
    userText(`Inspect ${hostname} ${repository} node_modules ${longUrl} ${longToken}`, { id: "prt_mobile_user" }),
  ])
  const assistant = assistantMessage([
    {
      id: "prt_mobile_assistant",
      type: "text",
      text: [
        `Host: ${hostname}`,
        `Repository: ${repository}`,
        `URL: ${longUrl}`,
        `Unbroken: ${longToken}`,
        "",
        `Inline path: \`/workspace/${repository}/node_modules/@scope/package/dist/a-file-with-a-very-long-name.ts\``,
        "",
        "```ts",
        `const endpoint = \"${longUrl}\"`,
        "```",
      ].join("\n"),
    },
    toolPart(
      "prt_mobile_tool",
      "list",
      "completed",
      { path: `/workspace/${repository}/node_modules/${longToken}` },
      { output: `${longUrl}\n/workspace/${repository}/node_modules/a-very-long-package-name/index.js\n${longToken}` },
    ),
  ])
  return [user, assistant]
}

test("keeps the conversation inside a 390px viewport without changing desktop", async ({ page }) => {
  await setupTimeline(page, {
    messages: overflowMessages(),
    settings: { newLayoutDesigns: true },
    viewport: { width: 390, height: 844 },
  })

  const conversation = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const composer = page.locator('[data-component="session-prompt-dock"]')
  await expect(conversation).toBeVisible()
  await expect(composer).toBeVisible()
  await page.evaluate((value) => {
    const assistant = document.querySelector<HTMLElement>('[data-slot="session-turn-assistant-content"]')!
    const output = document.createElement("div")
    output.dataset.component = "tool-output"
    output.innerHTML = `<pre><code>${value}</code></pre>`
    assistant.append(output)
  }, longToken)
  await expect(page.locator('[data-component="tool-output"]')).toBeVisible()

  const geometry = await page.evaluate(() => {
    const conversation = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
      element.querySelector("[data-timeline-row]"),
    )!
    const composer = document.querySelector<HTMLElement>('[data-component="session-prompt-dock"]')!
    const cards = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-component="user-message"], [data-slot="session-turn-assistant-content"], [data-component="card"], [data-component="tool-output"]',
      ),
    ]
    const userMessage = document.querySelector<HTMLElement>('[data-component="user-message"]')!
    const userText = document.querySelector<HTMLElement>('[data-slot="user-message-text"]')!
    const assistantMessage = document.querySelector<HTMLElement>('[data-slot="session-turn-assistant-content"]')!
    const markdown = document.querySelector<HTMLElement>('[data-component="markdown"]')!
    const toolOutput = document.querySelector<HTMLElement>('[data-component="tool-output"]')!
    const viewport = window.innerWidth
    const bounds = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width }
    }
    return {
      viewport,
      documentScrollWidth: document.documentElement.scrollWidth,
      conversationClientWidth: conversation.clientWidth,
      conversationScrollWidth: conversation.scrollWidth,
      styles: {
        conversationOverflowX: getComputedStyle(conversation).overflowX,
        userMinWidth: getComputedStyle(userMessage).minWidth,
        userMaxWidth: getComputedStyle(userMessage).maxWidth,
        userTextOverflowWrap: getComputedStyle(userText).overflowWrap,
        assistantMinWidth: getComputedStyle(assistantMessage).minWidth,
        assistantMaxWidth: getComputedStyle(assistantMessage).maxWidth,
        markdownOverflowWrap: getComputedStyle(markdown).overflowWrap,
        toolOutputMinWidth: getComputedStyle(toolOutput).minWidth,
        toolOutputMaxWidth: getComputedStyle(toolOutput).maxWidth,
        toolOutputWhiteSpace: getComputedStyle(toolOutput).whiteSpace,
        composerMinWidth: getComputedStyle(composer).minWidth,
        composerMaxWidth: getComputedStyle(composer).maxWidth,
      },
      composer: bounds(composer),
      cards: cards.map(bounds),
    }
  })

  expect(geometry.documentScrollWidth).toBe(geometry.viewport)
  expect(geometry.conversationScrollWidth).toBe(geometry.conversationClientWidth)
  expect(geometry.styles).toEqual({
    conversationOverflowX: "hidden",
    userMinWidth: "0px",
    userMaxWidth: "100%",
    userTextOverflowWrap: "anywhere",
    assistantMinWidth: "0px",
    assistantMaxWidth: "100%",
    markdownOverflowWrap: "anywhere",
    toolOutputMinWidth: "0px",
    toolOutputMaxWidth: "100%",
    toolOutputWhiteSpace: "normal",
    composerMinWidth: "0px",
    composerMaxWidth: "100%",
  })
  expect(geometry.composer.left).toBeGreaterThanOrEqual(0)
  expect(geometry.composer.right).toBeLessThanOrEqual(geometry.viewport)
  for (const card of geometry.cards) {
    expect(card.left).toBeGreaterThanOrEqual(0)
    expect(card.right).toBeLessThanOrEqual(geometry.viewport)
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  const desktop = await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>('[data-component="session-prompt-dock"]')!
    const cards = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-component="user-message"], [data-slot="session-turn-assistant-content"], [data-component="card"]',
      ),
    ]
    const viewport = window.innerWidth
    const bounds = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    }
    return {
      viewport,
      documentScrollWidth: document.documentElement.scrollWidth,
      composer: bounds(composer),
      cards: cards.map(bounds),
    }
  })

  expect(desktop.documentScrollWidth).toBe(desktop.viewport)
  expect(desktop.composer.left).toBeGreaterThanOrEqual(0)
  expect(desktop.composer.right).toBeLessThanOrEqual(desktop.viewport)
  for (const card of desktop.cards) {
    expect(card.left).toBeGreaterThanOrEqual(0)
    expect(card.right).toBeLessThanOrEqual(desktop.viewport)
  }
})
