import { expect, test } from '@playwright/test';
import { dismissOnboardingIfPresent, dismissOpenDialogIfPresent } from './chat-scroll-regression-helpers.js';

// Desktop/mobile parity for the agent tool-calling UI: the editor's tool picker,
// insert-output-only prompt source, and the settings panel's hidden-tools picker.
// Run with: SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:<port> npx playwright test in-chat-agents-tool-calling-ui.e2e.js

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const TEST_TOOL_NAMES = ['e2e_read', 'e2e_search', 'e2e_update'];

async function openApp(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    const state = { agentSaves: [] };
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/in-chat-agents/save') {
            state.agentSaves.push(request.postDataJSON());
            return route.fulfill({ json: {} });
        }
        // Browser tests never send inference, secrets, or mutations to a real service.
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (/^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)$/.test(url.pathname)) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await dismissOnboardingIfPresent(page);
    const onboardingSave = page.locator('dialog[open]:has(.onboarding) .popup-button-ok');
    if (await onboardingSave.isVisible()) await onboardingSave.click();
    await dismissOpenDialogIfPresent(page);
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => {
        await wizard.getByRole('button', { name: 'Skip', exact: true }).click();
    });
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady, null, { timeout: 60000 });
    await page.waitForFunction(() => typeof window.SillyTavern?.getContext === 'function');
    await page.locator('#ica--settings').waitFor({ state: 'attached', timeout: 60000 });
    return state;
}

async function registerTools(page, names) {
    await page.evaluate(toolNames => {
        const ctx = window.SillyTavern.getContext();
        for (const name of toolNames) {
            ctx.registerFunctionTool({
                name,
                displayName: `E2E ${name}`,
                description: 'Browser test tool.',
                parameters: { type: 'object', properties: {} },
                action: async () => 'ok',
                shouldRegister: () => true,
            });
        }
    }, names);
}

async function openAgentsTab(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
    await expect(page.locator('#ica--addAgent')).toBeVisible();
}

async function press(locator, touch) {
    await locator.scrollIntoViewIfNeeded();
    if (touch) {
        await locator.tap();
    } else {
        await locator.click();
    }
}

function getHorizontalOverflow(page) {
    return page.evaluate(() => {
        const dialog = document.querySelector('dialog[open]');
        const viewportWidth = window.innerWidth;
        const escaping = [...(dialog?.querySelectorAll('select, input, textarea, label') ?? [])]
            .filter(element => element.getClientRects().length)
            .filter(element => element.getBoundingClientRect().right > viewportWidth + 1)
            .map(element => element.id || element.tagName);
        return {
            document: document.documentElement.scrollWidth - viewportWidth,
            escaping,
        };
    });
}

async function runEditorRoundTrip(page, baseURL, { agentName, touch }) {
    const state = await openApp(page, baseURL);
    await registerTools(page, TEST_TOOL_NAMES);
    await openAgentsTab(page);
    await press(page.locator('#ica--addAgent'), touch);

    const dialog = page.locator('dialog[open]');
    await expect(dialog.locator('#ica--editor-name')).toBeVisible();
    await dialog.locator('#ica--editor-name').fill(agentName);
    await dialog.locator('#ica--editor-prompt').fill('Look up game data for the latest message.');

    await expect(dialog.locator('#ica--tool-calling-mode-row')).toBeHidden();
    await press(dialog.locator('#ica--editor-toolCalling-enabled'), touch);
    await expect(dialog.locator('#ica--editor-toolCalling-enabled')).toBeChecked();
    await expect(dialog.locator('#ica--tool-calling-mode-row')).toBeVisible();
    await dialog.locator('#ica--editor-toolCalling-mode').selectOption('selected');

    const toolPicker = dialog.locator('#ica--editor-toolCalling-selectedTools');
    await expect(toolPicker).toBeVisible();
    for (const name of TEST_TOOL_NAMES) {
        await expect(toolPicker.locator(`option[value="${name}"]`)).toHaveText(`E2E ${name}`);
    }
    await toolPicker.selectOption(['e2e_read', 'e2e_search']);

    await dialog.locator('#ica--editor-phase').selectOption('pre');
    await dialog.locator('#ica--editor-pre-mode').selectOption('intercept');
    const promptSourceRow = dialog.locator('#ica--pre-prompt-source-row');
    await dialog.locator('#ica--editor-pre-applyMode').selectOption('replace');
    await expect(promptSourceRow).toBeHidden();
    await dialog.locator('#ica--editor-pre-applyMode').selectOption('wrap-insert-output-only');
    await expect(promptSourceRow).toBeVisible();
    await dialog.locator('#ica--editor-pre-promptSource').selectOption('own-preset');
    await dialog.locator('#ica--editor-pre-contextScope').selectOption('recent');
    await expect(dialog.locator('#ica--pre-context-recent-row')).toBeVisible();

    const overflow = await getHorizontalOverflow(page);
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.escaping).toEqual([]);

    await press(dialog.locator('.popup-button-ok'), touch);
    await expect.poll(() => state.agentSaves.length).toBe(1);
    expect(state.agentSaves[0]).toMatchObject({
        name: agentName,
        toolCalling: { enabled: true, mode: 'selected', selectedTools: ['e2e_read', 'e2e_search'] },
        preProcess: { mode: 'intercept', applyMode: 'wrap', insertOutputOnly: true, promptSource: 'own-preset', contextScope: 'recent' },
    });

    await openAgentsTab(page);
    const card = page.locator(`.ica--agent-card[data-agent-id="${state.agentSaves[0].id}"]`);
    await press(card.locator('.ica--card-name'), touch);
    await expect(dialog.locator('#ica--editor-name')).toHaveValue(agentName);
    await expect(dialog.locator('#ica--editor-toolCalling-enabled')).toBeChecked();
    await expect(dialog.locator('#ica--editor-toolCalling-selectedTools')).toHaveValues(['e2e_read', 'e2e_search']);
    await expect(dialog.locator('#ica--editor-pre-applyMode')).toHaveValue('wrap-insert-output-only');
    await expect(dialog.locator('#ica--editor-pre-promptSource')).toHaveValue('own-preset');
    await press(dialog.locator('.popup-button-cancel'), touch);
    return state.agentSaves;
}

async function runHiddenToolsPickerRefresh(page, baseURL, { touch }) {
    await openApp(page, baseURL);
    const lateToolName = 'e2e_registered_after_mount';
    await registerTools(page, [lateToolName]);
    await openAgentsTab(page);

    const picker = page.locator('#ica--hiddenMainGenerationToolNames');
    await expect(picker.locator(`option[value="${lateToolName}"]`)).toHaveCount(1);
    await picker.scrollIntoViewIfNeeded();
    await expect(picker).toBeVisible();
    if (touch) {
        await picker.tap();
    }
    await picker.selectOption([lateToolName]);
    await expect.poll(() => page.evaluate(async () => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        return [...store.getHiddenMainGenerationToolNames()];
    })).toEqual([lateToolName]);

    const pickerBox = await picker.boundingBox();
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    return lateToolName;
}

test.describe('agent tool-calling UI at desktop 1280x900', () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('editor tool picker and prompt source round-trip through save', async ({ page, baseURL }) => {
        const saves = await runEditorRoundTrip(page, baseURL, { agentName: 'E2E Lookup Desktop', touch: false });
        expect(saves).toHaveLength(1);
    });

    test('hidden-tools picker lists a tool registered after the panel mounted', async ({ page, baseURL }) => {
        const lateToolName = await runHiddenToolsPickerRefresh(page, baseURL, { touch: false });
        await expect(page.locator(`#ica--hiddenMainGenerationToolNames option[value="${lateToolName}"]`)).toHaveCount(1);
    });
});

test.describe('agent tool-calling UI at iPhone 390x844', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('editor tool picker and prompt source round-trip through save by touch', async ({ page, baseURL }) => {
        const saves = await runEditorRoundTrip(page, baseURL, { agentName: 'E2E Lookup Mobile', touch: true });
        expect(saves).toHaveLength(1);
    });

    test('hidden-tools picker lists a late tool and fits the mobile viewport', async ({ page, baseURL }) => {
        const lateToolName = await runHiddenToolsPickerRefresh(page, baseURL, { touch: true });
        await expect(page.locator(`#ica--hiddenMainGenerationToolNames option[value="${lateToolName}"]`)).toHaveCount(1);
    });
});
