const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs'); // 파일 시스템 추가

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 4000;

let browser = null;

async function initBrowser() {
    if (!browser) {
        console.log('🚀 Chrome 실행 중...');
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800']
        });
    }
    return browser;
}

app.post('/scrape', async (req, res) => {
    const { nickname, serverId = 1006 } = req.body;
    console.log(`[요청] ${nickname} (서버: ${serverId}) 검색 시작...`);

    let page = null;
    try {
        const browser = await initBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto('https://aion2tool.com', { waitUntil: 'networkidle2' });

        // 2. 종족 선택
        try {
            await page.waitForSelector('#race-elyos', { timeout: 3000 });
            await page.click('#race-elyos');
        } catch (e) {
            console.log("⚠️ 종족 선택 실패");
        }

        // 3. 서버 선택
        try {
            await page.waitForSelector('#server-select', { timeout: 3000 });
            await page.select('#server-select', String(serverId));
        } catch (e) {
            console.log("⚠️ 서버 선택 실패");
        }

        // 4. 입력 & 엔터
        const inputSelector = 'input[placeholder="캐릭터 닉네임 입력"]';
        await page.waitForSelector(inputSelector);

        await page.type(inputSelector, nickname);
        await new Promise(r => setTimeout(r, 200));
        await page.keyboard.press('Enter');

        // 5. 로딩 (시간 넉넉히)
        try {
            await page.waitForFunction(
                () => document.body.innerText.includes("종합 능력치") || document.body.innerText.includes("전투력"),
                { timeout: 15000 }
            );
        } catch (e) {
            // [디버깅] 실패 시 스크린샷 저장
            await page.screenshot({ path: `error_${nickname}.png` });
            throw new Error("PROFILE_LOAD_TIMEOUT");
        }

        const data = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return {
                raw: bodyText,
                lines: bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
            };
        });

        const raw = data.raw;
        const lines = data.lines;

        const jobs = ["수호성", "검성", "살성", "궁성", "마도성", "정령성", "치유성", "호법성"];
        const job = jobs.find(j => raw.includes(j)) || "미정";

        let power = 0;
        const powerMatch = raw.match(/전투력\s*([\d,]+)/);
        if (powerMatch) power = parseInt(powerMatch[1].replace(/,/g, ''));

        let guild = "-";
        const legionLine = lines.find(l => l.includes('레기온') && !l.includes('전체') && !l.includes('필터') && !l.includes('랭킹'));
        if (legionLine) {
            const match = legionLine.match(/([^\s]+)\s*레기온/);
            if (match && match[1] !== '프') guild = match[1];
            else {
                const match2 = legionLine.match(/레기온\s*[:]?\s*([^\s]+)/);
                if (match2) guild = match2[1];
            }
        }
        if (guild === "-" || guild === "프") {
            const chuLine = lines.find(l => l === "츄" || l === "츄 레기온");
            if (chuLine) guild = "츄";
        }
        if (guild === "랭킹") guild = "-";

        let score = 0;
        const scoreMatch = raw.match(/(Score|점수|RP|어비스 포인트)\s*[:]?\s*([\d,]+)/i);
        if (scoreMatch) score = parseInt(scoreMatch[2].replace(/,/g, ''));

        // [디버깅] 0점일 경우에도 스크린샷
        if (power === 0) {
            await page.screenshot({ path: `zero_power_${nickname}.png` });
            throw new Error("INVALID_DATA (Power is 0)");
        }

        console.log(`[성공] ${nickname} -> ${job} / ${power} / ${guild} / ${score}`);

        res.json({ success: true, data: { name: nickname, class: job, power: power, guild: guild, score: score } });

    } catch (e) {
        console.error(`[실패] ${nickname}: ${e.message}`);
        // 에러 스크린샷이 이미 찍혔는지 확인하고 없으면 여기서 찍기
        if (page && !e.message.includes("TIMEOUT")) { // 타임아웃은 위에서 찍음
            try { await page.screenshot({ path: `fatal_${nickname}.png` }); } catch { }
        }
        res.json({ success: false, error: e.message });
    } finally {
        if (page) await page.close();
    }
});

app.listen(PORT, () => {
    console.log(`Example app listening on port ${PORT}`);
});
