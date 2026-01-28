const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 4000;

let browser = null;

async function initBrowser() {
    console.log('🚀 Chrome 실행 준비 (화면 표시 모드)...');
    return await puppeteer.launch({
        headless: false, // 화면 띄우기
        defaultViewport: null,
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
    });
}

app.post('/scrape', async (req, res) => {
    const { nickname, serverId = 1006 } = req.body;
    console.log(`[요청] ${nickname} (서버: ${serverId}) 검색 시작...`);

    let page = null;
    let localBrowser = null;

    try {
        localBrowser = await initBrowser();

        // [수정 핵심] 새 탭을 또 만들지 않고, 이미 열려있는 첫 번째 탭을 잡아서 씁니다.
        const pages = await localBrowser.pages();
        if (pages.length > 0) {
            page = pages[0]; // 첫 번째 탭 사용
        } else {
            page = await localBrowser.newPage(); // 없으면 만듦
        }

        await page.bringToFront(); // 탭을 맨 앞으로 가져옴 (포커스)

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
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');
        console.log("✅ 엔터 입력 (화면을 지켜보세요)");

        // 5. 로딩 (대기 시간 60초)
        try {
            await page.waitForFunction(
                () => document.body.innerText.includes("종합 능력치") ||
                    document.body.innerText.includes("전투력") ||
                    (document.body.innerText.includes("검색어에 해당하는") && !document.body.innerText.includes("로딩 중")),
                { timeout: 60000 }
            );
        } catch (e) {
            console.log("⚠️ 로딩 타임아웃!");
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

        if (raw.includes("검색어에 해당하는 캐릭터가 없습니다")) {
            throw new Error("CHARACTER_NOT_FOUND");
        }

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

        if (power === 0) throw new Error("INVALID_DATA (Power is 0)");

        console.log(`[성공] ${nickname} -> ${job} / ${power} / ${guild} / ${score}`);

        res.json({ success: true, data: { name: nickname, class: job, power: power, guild: guild, score: score } });

    } catch (e) {
        console.error(`[실패] ${nickname}: ${e.message}`);
        res.json({ success: false, error: e.message });
    } finally {
        console.log("👀 디버깅을 위해 브라우저를 닫지 않습니다.");
        // if (localBrowser) await localBrowser.close(); 
    }
});

app.listen(PORT, () => {
    console.log(`Debug Server running on port ${PORT}`);
});
