const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const serviceAccount = require('./system_core.json');

// Firebase Admin Init
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://aion2-guild-default-rtdb.asia-southeast1.firebasedatabase.app"
});
const db = admin.database();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 4000;

// [최적화] 전역 브라우저 변수 (하나로 돌려쓰기)
let globalBrowser = null;

async function getBrowser() {
    // 브라우저가 없거나 죽었으면 새로 실행
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log('🚀 Chrome 인스턴스 시작 (무한 재사용 모드)...');
        globalBrowser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote'
            ]
        });
    }
    return globalBrowser;
}

// 공통 스크래핑 로직 함수
async function scrapeCharacter(nickname, serverId = 1006) {
    console.log(`[검색] ${nickname} (서버: ${serverId}) 시작...`);

    let page = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 2;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        if (attempts > 1) console.log(`🔄 [재시도] ${nickname} (시도 ${attempts}/${MAX_ATTEMPTS})`);

        try {
            const browser = await getBrowser();
            page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });

            // 리소스 차단
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.goto('https://aion2tool.com', { waitUntil: 'domcontentloaded' });

            // 종족 선택 (천족)
            try {
                await page.waitForSelector('#race-elyos', { timeout: 3000 });
                await page.click('#race-elyos');
            } catch (e) { }

            // 서버 선택
            try {
                await page.waitForSelector('#server-select', { timeout: 3000 });
                await page.select('#server-select', String(serverId));
            } catch (e) { }

            // 검색어 입력
            const inputSelector = 'input[placeholder="캐릭터 닉네임 입력"]';
            await page.waitForSelector(inputSelector);
            await page.type(inputSelector, nickname);
            await new Promise(r => setTimeout(r, 300));
            await page.keyboard.press('Enter');

            // 로딩 대기
            try {
                await page.waitForFunction(
                    () => {
                        const notFound = document.body.innerText.includes("검색어에 해당하는");
                        if (notFound) return true;
                        const powerEl = document.querySelector('#result-combat-power');
                        const scoreEl = document.querySelector('#dps-score-value');
                        return (powerEl && /\d/.test(powerEl.innerText)) && (scoreEl && /\d/.test(scoreEl.innerText));
                    },
                    { timeout: 45000 }
                );
            } catch (e) {
                console.log("⚠️ 로딩 타임아웃 (부분 데이터 가능성)");
            }

            // 데이터 추출
            const data = await page.evaluate(() => {
                const bodyText = document.body.innerText;
                const powerEl = document.getElementById('result-combat-power');
                const scoreEl = document.getElementById('dps-score-value');
                return {
                    raw: bodyText,
                    lines: bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0),
                    idPower: powerEl ? powerEl.innerText : null,
                    idScore: scoreEl ? scoreEl.innerText : null
                };
            });

            if (data.raw.includes("검색어에 해당하는 캐릭터가 없습니다")) {
                if (page) await page.close();
                return { success: false, error: "CHARACTER_NOT_FOUND" };
            }

            const jobs = ["수호성", "검성", "살성", "궁성", "마도성", "정령성", "치유성", "호법성"];
            const job = jobs.find(j => data.raw.includes(j)) || "미정";

            let power = parseInt((data.idPower || '').replace(/[^0-9]/g, '')) || 0;
            if (power === 0) {
                const powerMatch = data.raw.match(/전투력\s*([\d,]+)/);
                if (powerMatch) power = parseInt(powerMatch[1].replace(/,/g, ''));
            }

            let guild = "-";
            const legionLine = data.lines.find(l => l.includes('레기온') && !l.includes('전체') && !l.includes('랭킹'));
            if (legionLine) {
                const match = legionLine.match(/([^\s]+)\s*레기온/);
                if (match && match[1] !== '프') guild = match[1];
                else {
                    const match2 = legionLine.match(/레기온\s*[:]?\s*([^\s]+)/);
                    if (match2) guild = match2[1];
                }
            }
            if (guild === "-" || guild === "프") {
                if (data.lines.some(l => l === "츄" || l === "츄 레기온")) guild = "츄";
            }
            if (guild === "랭킹") guild = "-";

            let score = parseInt((data.idScore || '').replace(/[^0-9]/g, '')) || 0;
            if (score === 0) {
                const scoreMatch = data.raw.match(/(Score|점수|RP|어비스 포인트)\s*[:]?\s*([\d,]+)/i);
                if (scoreMatch) score = parseInt(scoreMatch[2].replace(/,/g, ''));
            }

            // 재시도 조건
            if (power > 0 && score === 0) {
                console.log(`⚠️ 불완전 데이터 (Power: ${power}, Score: ${score}). 재시도...`);
                if (page) await page.close();
                continue;
            }

            if (power === 0) throw new Error("INVALID_DATA (Power is 0)");

            console.log(`[성공] ${nickname} -> ${power} / ${score}`);
            if (page) await page.close();
            return {
                success: true,
                data: { name: nickname, class: job, power, guild, score }
            };

        } catch (e) {
            console.error(`[실패] ${nickname}: ${e.message}`);
            if (page) await page.close();
            if (attempts === MAX_ATTEMPTS) return { success: false, error: e.message };
        }
    }
}

// API Endpoint
app.post('/scrape', async (req, res) => {
    const { nickname, serverId = 1006 } = req.body;
    const result = await scrapeCharacter(nickname, serverId);
    res.json(result);
});

// Cron Job: 매 시간 0분에 실행 (0 * * * *)
cron.schedule('0 * * * *', async () => {
    const now = new Date();
    console.log(`========================================`);
    console.log(`⏰ [Auto-Refresh] 자동 갱신 시작 (${now.toLocaleString()})`);

    try {
        const snapshot = await db.ref('members').once('value');
        const members = snapshot.val();
        if (!members) {
            console.log("멤버 데이터가 없습니다.");
            return;
        }

        const memberList = Array.isArray(members) ? members : Object.values(members);
        let successCount = 0;

        for (let i = 0; i < memberList.length; i++) {
            const member = memberList[i];
            if (!member || !member.name) continue;

            console.log(`[Auto] ${i + 1}/${memberList.length}: ${member.name} 갱신 중...`);

            // 딜레이 (서버 부하 방지 - 적당히)
            if (i > 0) await new Promise(r => setTimeout(r, 5000));

            const res = await scrapeCharacter(member.name);
            if (res.success && res.data) {
                // 해당 인덱스의 데이터 업데이트
                await db.ref(`members/${i}`).update({
                    power: res.data.power,
                    score: res.data.score,
                    class: res.data.class,
                    guild: res.data.guild,
                    isActive: (res.data.guild === '츄'),
                    lastUpdated: new Date().toISOString()
                });
                successCount++;
            }
        }
        console.log(`✅ [Auto-Refresh] 갱신 완료! (성공: ${successCount}/${memberList.length})`);

    } catch (e) {
        console.error(`❌ [Auto-Refresh] 에러 발생:`, e);
    }
});

app.listen(PORT, () => {
    console.log(`🤖 Server & Automation running on port ${PORT}`);
});
