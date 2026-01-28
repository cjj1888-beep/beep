const puppeteer = require('puppeteer');

(async () => {
    // 테스트할 닉네임
    const nickname = "부트띠";
    const serverId = "1006";

    console.log(`🔍 [서브컴 UI 정밀분석] '${nickname}' 검색 시작...`);

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        await page.goto('https://aion2tool.com', { waitUntil: 'networkidle2' });

        // 종족/서버 선택
        try {
            await page.waitForSelector('#race-elyos', { timeout: 3000 });
            await page.click('#race-elyos');
            await page.waitForSelector('#server-select', { timeout: 3000 });
            await page.select('#server-select', serverId);
        } catch (e) {
            console.log("⚠️ 설정 스킵됨");
        }

        // 입력 & 엔터
        const inputSelector = 'input[placeholder="캐릭터 닉네임 입력"]';
        await page.waitForSelector(inputSelector);
        await page.type(inputSelector, nickname);
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');

        console.log("⏳ 결과 대기 중...");

        await new Promise(r => setTimeout(r, 5000)); // 5초 깡대기 (로딩 넉넉히)

        // HTML 및 텍스트 덤프
        const info = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const fullHTML = document.body.innerHTML;

            // "전투력" 키워드가 포함된 요소 찾기
            const powerEls = Array.from(document.querySelectorAll('*')).filter(el =>
                el.children.length === 0 && el.innerText && el.innerText.includes('전투력')
            );

            const powerContext = powerEls.map(el => ({
                tag: el.tagName,
                text: el.innerText,
                html: el.outerHTML,
                parentHTML: el.parentElement ? el.parentElement.outerHTML.substring(0, 200) + "..." : "No Parent"
            }));

            return {
                text: bodyText,
                html: fullHTML,
                powerContext: powerContext
            };
        });

        console.log("--- [TEXT DUMP (상위 100줄)] ---");
        const lines = info.text.split('\n').filter(l => l.trim().length > 0);
        lines.slice(0, 100).forEach((l, i) => console.log(`[${i}] ${l.trim()}`));

        console.log("\n--- [전투력 요소 분석] ---");
        if (info.powerContext.length === 0) {
            console.log("⚠️ '전투력'이라는 텍스트를 가진 요소를 못 찾았습니다!");
        } else {
            info.powerContext.forEach((ctx, i) => {
                console.log(`[Item ${i}] 태그: ${ctx.tag}`);
                console.log(`  └ 텍스트: ${ctx.text}`);
                console.log(`  └ HTML: ${ctx.html}`);
                console.log(`  └ 부모HTML: ${ctx.parentHTML}\n`);
            });
        }

        console.log("\n--- [스크린샷 저장] ---");
        await page.screenshot({ path: 'debug_ui_analysis.png', fullPage: true });
        console.log("📸 debug_ui_analysis.png 저장 완료");

    } catch (e) {
        console.error("❌ 에러:", e.message);
    } finally {
        console.log("👀 창을 닫지 않습니다. 분석 결과를 확인하세요.");
        // await browser.close();
    }
})();
