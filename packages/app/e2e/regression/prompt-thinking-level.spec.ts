import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PromptThinkingLevelRegression"
const projectID = "proj_prompt_thinking_level_regression"
const sessionID = "ses_prompt_thinking_level_regression"

test("shows the V2 thinking level control while relevant", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-thinking-level-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "thinking-model": {
              id: "thinking-model",
              name: "Thinking Model",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "thinking-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-thinking-level-regression",
        projectID,
        directory,
        title: "Prompt thinking level regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const input = composer.locator('[data-component="prompt-input"]')
  const control = composer.getByRole("button", { name: "Choose model variant" })
  await expectAppVisible(composer)

  await idleComposer(page)
  await expect(control).toBeVisible()

  await control.click()
  const high = page.getByRole("menuitemradio", { name: "high" })
  await expect(high).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(control).toBeVisible()
  await expect(high).toBeVisible()
  await high.click()

  await idleComposer(page)
  await input.focus()
  await expect(control).toBeVisible()

  await idleComposer(page)
  await expect(control).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.addStyleTag({ content: ":root { font-size: 32px !important; }" })
  const submit = composer.getByRole("button", { name: "Send" })
  await expect(submit).toBeVisible()

  const controls = await page.evaluate(() => {
    const variant = document.querySelector<HTMLElement>('[aria-label="Choose model variant"]')!
    const submit = document.querySelector<HTMLElement>('[data-action="prompt-submit"]')!
    const variantRect = variant.getBoundingClientRect()
    const submitRect = submit.getBoundingClientRect()
    const hit = document.elementFromPoint(submitRect.left + submitRect.width / 2, submitRect.top + submitRect.height / 2)
    return {
      variantRight: variantRect.right,
      submitLeft: submitRect.left,
      submitHit: hit === submit || submit.contains(hit),
    }
  })

  expect(controls.variantRight).toBeLessThanOrEqual(controls.submitLeft)
  expect(controls.submitHit).toBe(true)
})

async function idleComposer(page: Page) {
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}
