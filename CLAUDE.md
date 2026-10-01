本檔是給 AI 開發助手的內部開發筆記，含開發者本機路徑與歷程；一般使用者不需閱讀，請從 README.md 開始。

# osep-judge｜Scratch介面程式解題平台

從`osep-scratch-editor`（ESP8266 SmartRing硬體+LED模擬器教學平台，路徑`D:\yosep\osep-scratch-editor`
／`C:\yosep\osep-scratch-editor`，繼續獨立運作、完全沒動）複製建立的**獨立新專案**，
2026-08-04起改走純解題路線：保留scratch-vm真正的執行引擎，砍掉舞台/角色/造型/音效UI，
改成「積木畫布＋題目評分面板」的Scratch程式解題平台，比照官方平台
`https://demo.csie.ntnu.edu.tw/ps/solo?quiz=scratch-card`的版面與評分機制，
並導入BlocklyYdws（`D:\yosep\BlocklyYdws`）已開發的M0~M2程式解題課程內容。

GitHub：`https://github.com/p2766602-beep/osep-judge`（public，2026-08-04從private改過來）。

## 最近一次工作階段交接（2026-08-04，第二輪）

**GitHub Pages已確認上線**：`https://p2766602-beep.github.io/osep-judge/` 重新查證回傳
HTTP 200（上一輪交接時還是404，這輪之後GitHub應該是處理完了，沒有再多做設定）。

**`gh auth login`仍未執行**——這步一樣需要使用者自己跑互動式登入。補充：登入狀態是
**跟著這台電腦走，不是跟著對話走**（存在本機的gh設定檔裡），這台學校電腦登入一次之後，
之後不管開幾次新的Claude Code對話都不用重登，除非登出/token失效，或換到另一台電腦。

**擴大題目範圍：M0-01（6題全）＋M0-02（8題全）已完成，本機瀏覽器完整實測通過**。
這輪沒有逐題手動照抄`build-m0-01-sb3.js`（那份只做過A-01-0，方法太慢也容易手抖出錯），
改寫成一套通用的Blockly starterXml → Scratch積木轉換器：

- `scripts/judge-dev-tools/xml-to-scratch.js`：通用轉換器本體（極簡XML解析器＋積木對照表），
  支援`event_whenflagclicked`／`interaction_ask_and_wait`／`interaction_answer`／
  `interaction_say`／`variables_set`／`variables_get`／`text`／`math_number`／`text_join`
  （N元攤平成operator_join鏈）／`math_arithmetic`／`math_round`（ROUND→operator_round，
  ROUNDDOWN/ROUNDUP→operator_mathop floor/ceiling）／`math_modulo`／`logic_compare`／
  `controls_if`（含elseif/else mutation，遞迴展開成巢狀control_if_else鏈）。之後M1/M2要用
  到新積木類型時，照這個檔案的模式加對照規則即可，不用整個重寫。
- `scripts/judge-dev-tools/build-m0-course-sb3.js`：讀BlocklyYdws課程檔（目前
  `M0-01-BasicOutput.js`/`M0-02-Variables.js`，之後要擴充課程只要加進`COURSE_FILES`陣列），
  跑轉換器產生`.sb3`到`static/judge-content/m0/<課程資料夾>/<題號>.sb3`。
- `scripts/judge-dev-tools/verify-m0-course.js`：headless用正式`tw-judge-engine.js`模組
  對每份`.sb3`跑BlocklyYdws原始testCases，**逐筆看`r.pass`（實際輸出===預期輸出），
  不能只比`totalScore===maxScore`**——見下方「已知資料缺口」。
- `scripts/judge-dev-tools/gen-judge-content.js`：從BlocklyYdws課程檔自動產生
  `src/lib/judge-content.js`（description/examples/testCases/difficulty＋對應sb3Path），
  **這個檔案現在是自動產生的，不要手動編輯，要改題目內容去改BlocklyYdws來源**。

**過程中發現並修好一個評分引擎的真bug**：`src/lib/tw-judge-engine.js`原本的
`onQuestion`只回答第一次「詢問並等待」，第二次以後的問題永遠不理，導致任何超過一次
詢問的題目都會卡住逾時判FAIL（M0-01有4題、M0-02全部8題都是多次詢問）。已改成比照
BlocklyYdws `src/main.js`的`createTokenReader()`：把`testCase.input`整個用空白（含換行）
斷詞，依序逐一回答每次詢問，不管原始測資是空白分隔（如M0-02的`"10 3 5 2"`）還是換行
分隔（如M0-01的`"John\nAmy"`），行為都跟BlocklyYdws平台本身一致。

**已知資料缺口（沒有動，留給使用者決定）**：BlocklyYdws來源`M0-02-Variables.js`的
全部testCase的`score`欄位都是`0`（M0-01是每筆10分，共40分；M0-02看起來像是欄位還沒
填）。目前`judge-content.js`忠實照抄這個0分，代表M0-02在UI上評分會顯示「分數：0/0」，
即使4筆測資全部實際答對（瀏覽器已實測確認：「找零錢」題4筆全部「通過」但顯示0/0）。
**沒有替BlocklyYdws決定要填多少分**，這是要不要動upstream資料的決定，留給使用者。

**本機瀏覽器完整實測**（`npm start`起dev server，`http://localhost:8601/editor.html`）：
M0-01、M0-02共14題全部出現在題目列表；抽測「找零錢」（BSA01-005，含
無條件捨去＋餘數＋巢狀字串組合）跟「臺斤公斤大PK」（A-03-1，最複雜的巢狀
如果/否則如果/否則＋乘法比較）——載入範例後畫布積木正確顯示，自行測試分頁
輸入187正確輸出「3 3 7」，評分分頁「臺斤公斤大PK」正確拿到40/40。加上
headless腳本（`verify-m0-course.js`）14題全部逐筆功能正確，雙重驗證確認轉換器
跟評分引擎修復都是對的。

## 最近一次工作階段交接（2026-08-04，第三輪：UI/UX四項回饋）

本輪使用者實際看過本機瀏覽器畫面後提的四個回饋，全部已完成並重新編譯確認：

1. **題目列表課程組可折疊**：`task-list.jsx`的課程標題改成可點擊按鈕（▶/▼圖示），
   點擊切換該課程組題目清單顯示/隱藏，state只存在元件內（不記憶跨session，每次重新整理
   都是全部展開）。
2. **M0-02評分顯示0分的問題已確認並修正**：見下方「M0-02 score欄位已回填」。
3. **「載入範例」按鈕載入後顏色明顯改變**：`judge-panel.jsx`的`JudgePanel`新增
   `demoLoaded` state（切換題目時重置為false，`handleLoadDemo`成功後設true），
   `DescriptionTab`依這個狀態切換`styles.demoButton`／`styles.demoButtonLoaded`
   （黃底＋外框，文字也變成「✓ 已載入範例答案」），對照BlocklyYdws「載入範例答案可以
   評分但不算學生自己作答」的規則，讓老師從旁看畫面就能一眼判斷。
4. **新增對齊官方平台的「解題常用」積木群組**：`src/lib/make-toolbox-xml.js`新增
   `judgeHelpers`分類函式，塞在toolbox最前面（比動作分類還前面），包含
   `event_whenflagclicked`（當綠旗被點擊）／`looks_say`（說出）／
   `sensing_askandwait`（詢問並等待）／`sensing_answer`（詢問的答案）——**都是原生
   Scratch積木本身**，只是額外多列一份在這個自訂分類方便找，Blockly本來就允許同一種
   積木出現在多個toolbox分類，不影響其他分類原本的內容。另外多加一顆`looks_think`
   （思考）當作「訊息輸出／除錯」積木：`tw-judge-engine.js`的評分邏輯本來就只採計
   `type==='say'`，`think`型別不會算進最終比對，所以拿它當debug print語意上完全正確、
   零風險（不用另外寫真正的自訂VM extension，那條路線需要處理scratch-vm套件依賴/
   unsandboxed extension載入機制，複雜度高很多，決定不做）。同步更新
   `runTestCase()`多回傳一個`debugOutput`欄位（`gradeSubmission`不受影響，只有
   `SelfTestTab`會拿來額外顯示一段「除錯輸出（思考積木，不計分）」）。

**M0-02 score欄位已回填**：確認過BlocklyYdws自己的平台（`main.js`的
`getAssessmentScore()`）其實不看`testCase.score`欄位，是自己算`passed/total*100`
百分比，所以`M0-02-Variables.js`裡全部`score:0`是schema裡本來就沒填的欄位、
不是BlocklyYdws自己平台上的即時bug。已比照M0-01的慣例（每筆測資10分）把
`BlocklyYdws/src/courses/M0-02-Variables.js`全部32筆`"score": 0`改成
`"score": 10`，重跑`gen-judge-content.js`＋`verify-m0-course.js`確認14題全部
40/40（分數欄位）＋4/4（實際功能正確性）雙重通過。

**後續M0~M2其他課程的score欄位補齊流程（待辦）**：之後每擴充一個新課程檔進
`build-m0-course-sb3.js`/`gen-judge-content.js`的`COURSE_FILES`之前，**先去BlocklyYdws
來源檔案確認`testCases[].score`是不是又是全部0**（可能還有其他課程也有這個schema
沒填的狀況）。確認方式：`grep -c '"score": 0' <課程檔路徑>`，數字接近`題數×測資數`
就代表整份都沒填，比照這次的做法（每筆測資10分，`replace_all`改掉）處理，改完記得
同時通知BlocklyYdws那邊這個欄位現在被osep-judge實際使用了（雖然BlocklyYdws自己
平台不看這欄位，但現在多了一個外部消費者，之後BlocklyYdws那邊如果想清理/重構這個
schema要注意別破壞這個依賴）。

## 最近一次工作階段交接（2026-08-04，第四輪：手動測試改成真正的Scratch互動流程）

使用者親自去官方平台實測後回報：**手動測試「的確是跑迴圈方式」（一次一筆跳出視窗），
跟自動評分「一次讀N筆」是刻意並存的兩種輸入模式**——這是照顧國小學生原本的Scratch
操作習慣（按綠旗→跳出「詢問並等待」的原生輸入框→一筆一筆手動輸入），不是我原本以為
的「兩種都應該長得像自動評分」。已重新設計「自行測試」分頁對齊這個結論：

- **`src/lib/judge-manual-run.js`**：新增一個極簡pub/sub模組，讓`judge-panel.jsx`可以
  告訴`gui.jsx`「現在要把舞台顯示出來」。背景：整個MVP-33平台把舞台（StageWrapper）
  用CSS（`.hiddenStage`：1px＋opacity:0＋pointer-events:none）藏起來，「詢問並等待」
  的原生輸入框是舞台底下的子元件，舞台被藏起來時這個輸入框完全不會出現——已經**實測
  確認**：直接呼叫`vm.greenFlag()`會讓程式卡住等待輸入，但畫面上完全看不到任何輸入
  介面（也確認了平常學生根本點不到那顆原生綠旗，因為`pointer-events:none`，不用另外
  停用）。
- **`src/components/gui/gui.jsx`＋`gui.css`**：新增`.manual-run-stage`——舞台暫時顯示成
  浮在畫面右下角、`position:fixed`的小視窗（400px寬，z-index:600，蓋在積木工作區上面
  但不影響版面），透過訂閱`judge-manual-run.js`的狀態切換`.hiddenStage`/`.manualRunStage`。
- **`judge-panel.jsx`的`SelfTestTab`整個重寫**：拿掉舊的「一個字串自動斷詞」做法，
  改成「開始手動測試」按鈕——顯示舞台、把非stage角色`visible`設回`true`（讓角色/說話
  泡泡跟真正Scratch一樣看得到）、呼叫`vm.greenFlag()`跑真的程式，輪詢
  `vm.runtime.threads.length===0`偵測執行完畢後自動把舞台藏回去；另外有「停止」按鈕
  讓學生手動中斷。**跟`評分`分頁完全獨立**，評分那邊的`tw-judge-engine.js`／
  `gradeSubmission`／`prepareVmForGrading`（一次字串自動斷詞、強制visible=false）
  完全沒動，兩種模式並存不互相干擾。
- 已在瀏覽器完整實測：Hello world（單次詢問）跟購買文具（4次連續詢問）都測過，
  真的跳出跟原生Scratch一樣的輸入框，一筆一筆手動輸入正確存進對應變數、跑完自動
  收起舞台；評分分頁另外測過同一題40/40正常，兩套機制互不影響。
  （**除錯過程附註**：手動測試視窗是`position:fixed`定位，瀏覽器自動化工具的螢幕截圖
  座標换算成真實頁面座標時我人工换算了兩次才對準，這是自動化工具本身的座標精度問題，
  不是產品bug——真人用滑鼠點畫面上看到的位置，瀏覽器原生的hit-testing一定準。）

## 最近一次工作階段交接（2026-08-04，第五輪：手動測試面板兩項回饋）

使用者實際跑過第四輪的手動測試後回報兩個問題，都已修好並實測驗證：

1. **回答完問題後，「自行測試」面板上完全沒顯示任何輸出**：`SelfTestTab`（第四輪重寫時）
   只負責觸發真正的`vm.greenFlag()`跑起來，完全沒有攔截`SAY`事件、也沒有任何UI顯示結果。
   已補上：`handleStart`時註冊`vm.runtime.on('SAY', onSay)`，分別收集`type==='say'`
   （正式評分會採計的「說出」內容）跟`type==='think'`（「輸出訊息」除錯積木，不計分）；
   跑完（`finishRun`，由threads歸零的輪詢或按「停止」觸發）後分別顯示成「正式評分輸出
   （「說出」的內容）」與「除錯輸出（「輸出訊息」積木，不計分）」兩個區塊。

2. **手動測試跳出的視窗太小/看不清楚，要求只呈現「詢問並等待」的畫面，其他都拿掉**：
   這個改動牽涉到stage.jsx/stage-wrapper.jsx/gui.jsx三層元件，過程中連續踩到三個真的
   會讓畫面crash或版面跑掉的坑，**記錄下來給下次改動類似程式碼的人參考**：

   - **不能用`display: none`藏舞台canvas**：會把整個子樹從渲染樹拿掉，
     `canvas.getBoundingClientRect()`量到0寬度，scratch-render內部呼叫
     `getImageData(0寬度)`直接丟`IndexSizeError`噴出白畫面（已實測撞過，見git歷史裡
     曾經短暫出現過的`display:'none'`寫法，後來改掉了）。
   - **也不能用「舞台整個縮成1px」（跟上層`gui.jsx`的`.hiddenStage`同一招）去藏舞台
     canvas**：`.stage`的手足元素`.stageOverlays`（放「詢問並等待」輸入框的容器）是
     absolute定位、依賴`.stage`原本的完整版面尺寸（`stageDimensions`）對齊，把`.stage`
     縮小會讓`.stageOverlays`的絕對定位跟著跑掉，問題文字的label被裁掉、只剩下面的
     輸入框（已實測撞過）。**正確做法**：`.stage`維持原本完整尺寸（large模式480×360）
     留在版面裡，只用`opacity:0`+`pointer-events:none`（見`stage.css`的
     `.stageMinimalHidden`），不動尺寸。
   - 但完整尺寸的舞台會在輸入框上面留一大塊看不到內容的空白（180~360px不等，視
     stageSize而定）。**最後用「觀景窗」技巧解決**：外層`.manual-run-stage`容器高度
     只留輸入框需要的高度（110px）、`overflow:hidden`裁掉多餘空白；裡面多包一層
     `.manual-run-stage-viewport`，用`margin-top: -324px`（實測量出來的「舞台頂端到
     輸入框頂端」距離，large模式下的固定值）把整個舞台內容往上推，讓輸入框剛好落在
     這個小觀景窗裡。**這個324px是綁死在large stageSize的magic number，以後如果改
     `stageSize`（見gui.jsx）要重新實測量一次，不然版面會跟著跑掉。**
   - **中途還意外挖出一個更深的因果關係，順便修掉**：改成minimal模式後，「詢問並
     等待」的問題文字（`state.question`）變成永遠是空字串。查了`node_modules/
     scratch-vm/src/blocks/scratch3_sensing.js`的`_askNextQuestion()`原始碼才確認：
     這是scratch-vm自己刻意設計的行為——**角色`visible===true`時**，「詢問並等待」會
     故意對`QUESTION`事件emit空字串，改用`SAY`事件把問題文字echo成角色頭上的說話
     泡泡（畫在舞台canvas上）；**只有`visible===false`時**，才會把真正的問題文字直接
     放進`QUESTION`事件（也就是Question元件自己畫的label）。第四輪的`handleStart`
     誤把非stage角色`visible`設成`true`（原意是想讓學生「看到角色」，比照真正
     Scratch），但我們的舞台canvas本來就故意藏起來，echo到canvas上的說話泡泡自然
     也跟著看不到，導致label永遠空白。已改成`visible = false`（跟評分用的
     `prepareVmForGrading()`一致），問題文字改成從label正確顯示；跑完/按停止後會
     透過`previousVisibility`還原回學生原本的visible狀態，不留副作用。

   完整實測：Hello world單次詢問，面板只顯示問題label＋輸入框（無控制列、無角色/
   背景畫面、無多餘空白），輸入「Amy」後正確顯示「正式評分輸出」為「Hello, Amy」，
   跑完自動收起浮動視窗。headless腳本14題也重新跑過一次全部PASS，確認沒有連帶弄壞
   評分邏輯。

## 最近一次工作階段交接（2026-08-04，第六輪：範例測資換行顯示）

使用者發現題目說明的「範例測資」沒有正確保留換行——查證後確認**這是osep-judge端的呈現
bug，不是資料問題**：BlocklyYdws自己的範例資料格式其實已經很一致（固定筆數用單行空白
分隔，如M0-02「10 3 5 2」；變動筆數用兩行「第一行N，第二行N個數字」，M1系列已經在用
這個格式，如M1-01「3\n101 102 103」；單純多次詢問則一次詢問一行，如A-01-1「Amy\nJohn」），
BlocklyYdws自己網頁用`<pre>`保留這些換行，但`gen-judge-content.js`逐字複製過來的資料
在`judge-panel.jsx`卻是用普通`<div>`直接塞文字，瀏覽器預設`white-space:normal`會把
`\n`吃掉擠成一行，這個bug其實已經影響到當時已上線的M0-01/M0-02（例如「一起學習吧」
範例應該顯示兩行卻擠成一行）。

**修法：只補CSS，不動資料**。`judge-panel.css`新增`.example-value`（`white-space:
pre-wrap`，跟旁邊「說明」欄位的`.exampleExplanation`做法一致），`judge-panel.jsx`把
`{example.input}`/`{example.output}`包進這個class的`<span>`。不用改
`gen-judge-content.js`（已經是逐字複製，資料格式本來就對），也不用改BlocklyYdws來源
資料（它自己的三種格式規則本來就已經照這次確認的規則在做，之後擴充M1/M2原樣沿用
即可）。已實測確認：「一起學習吧」範例正確顯示兩行「Amy」/「John」；「購買文具」的
「10 3 5 2」（固定4筆單行空白分隔）維持顯示一行，沒有被誤拆。headless腳本14題重跑
確認沒有連帶影響評分邏輯（純UI顯示改動，預期本來就不影響）。

**第六輪後續微調**：使用者接著回報「輸入：」「輸出：」標題後面不該接著第一行資料
（那樣後續行會跟標題不對齊、視覺上很怪），要求標題後淨空、資料一律從下一行開頭開始。
把`.exampleValue`從`<span>`（inline，會接在「輸入：」後面）改成`<div>`（block-level，
天生會換到下一行），不用再加額外CSS。已實測確認：多行範例（Amy/John）跟單行範例
（10 3 5 2）現在都是「輸入：」單獨一行、資料從下一行開頭開始，兩種情況呈現一致。

## 課程代碼解鎖機制（2026-08-04新增，版權保護）

使用者提出版權保護考量，決定把課程組改回「要輸入代碼才能載入」（比照BlocklyYdws自己
「隱藏課程」的做法），取代MVP-33當初選擇的「直接點選瀏覽」設計。**決策過程見對話紀錄，
已跟使用者確認過的重點**：這只是降低隨手瀏覽到的機率，不是真正的存取控制——純靜態
GitHub Pages網站，代碼本身還是打包在公開JS檔案裡，用開發者工具找得到，跟BlocklyYdws
自己承認的限制一樣。使用者選的方案：**每個課程組各自一組代碼**（不是全部共用一組），
**解鎖狀態存localStorage**（同一台電腦同一個瀏覽器下次開不用重打）。

**實作（2026-08-05修正）**：一開始曾經另外做一份`course-unlock-codes.js`配置檔、
自己編了佔位用的代碼（如`ydws-m0-01`），**使用者指正後改掉**：解鎖代碼不應該是另外
發明的字串，而是**直接沿用BlocklyYdws自己的courseCode**——也就是來源課程檔的完整
檔名（不含`.js`，例如`M0-01-BasicOutput`、`M1-05-StringBasics`），這正是BlocklyYdws
`src/courses/index.js`裡`normalizeCourseCode()`／`getCourseGroup(code)`比對用的
同一套代碼（該函式只做trim+轉大寫，沒有另外截短）。已刪掉那份多餘的配置檔，改成
`gen-judge-content.js`直接讀BlocklyYdws來源課程檔自己的`code`欄位當作
`course.unlockCode`——**未來擴充M0其餘課程/M1/M2時，代碼會自動對齊BlocklyYdws的
檔名，不用另外維護一套代碼表，老師/學生也不用記兩套代碼**。

- `task-list.jsx`：沒解鎖的課程組只顯示🔒＋課程名稱＋一個代碼輸入框，代碼對了才會
  展開題目清單、同時記進localStorage（`osepJudgeUnlockedCourses`）。

**還沒完成瀏覽器視覺驗證**（Claude瀏覽器擴充功能中途斷線）——程式碼邏輯已經人工
檢查過、webpack有編譯成功、headless評分腳本14題也重跑確認沒有連帶壞掉（純UI gating
改動，預期本來就不影響評分邏輯），但下一輪開始前**務必先在瀏覽器裡實際測一次**：
1. 兩個課程組預設都應該顯示🔒鎖住的狀態，看不到題目清單。
2. 代碼打錯要顯示「代碼不正確」錯誤訊息。
3. **代碼打對要展開題目清單**——目前M0-01是`M0-01-BasicOutput`、M0-02是
   `M0-02-Variables`（不分大小寫），且重新整理頁面後應該記得已解鎖（不用重打代碼）。
4. 確認`localStorage.getItem('osepJudgeUnlockedCourses')`存的是解鎖過的課程代碼陣列。

## 最近一次工作階段交接（2026-08-10：M0~M1系列全部完成，題目範圍確定收斂）

**osep-judge的課程範圍已經定案：只上M0＋M1系列＋114縣市國小題目，不上M2/M3，也不上
JSA01/JSB02等一般題庫**（使用者原話：「osep-judge因為對象是國小，只要上傳M0、M1系列
及縣市國小題目即可」，後續再次確認「osep-judge這邊是國小為主，上架M0~M1即可」）。
**M2/M3系列雖然已經在BlocklyYdws/blockly-lab/YDWS-CodingBank canonical資料夾裡存在，
但故意不擴充進osep-judge**，跟M0/M1不是「還沒做到」的關係，是刻意的範圍收斂決定，
之後不用再主動問要不要做M2。

**本輪完成：M1-01~M1-12全部12個檔案、105題**，跟M0系列一樣「因為是國小，全部都要
附上參考解答」。累計目前osep-judge共20個課程、186題，全部用`verify-m0-course.js`
headless腳本對真正評分引擎（`tw-judge-engine.js`）驗證過，分數欄位與實際功能正確性
雙重通過，0個失敗。

**新增檔案**：`scripts/judge-dev-tools/build-m1-hand-authored.js`（M1系列的手寫Scratch
示範解答腳本，比照既有`build-m0-hand-authored.js`/`build-jsa00-hand-authored.js`/
`build-jsb00-hand-authored.js`的模式，內含`copyExisting(fromCourseFolder, fromTaskId,
toCourseFolder, toTaskId)`跨課程複製helper——M1系列有相當多題目跟JSA00/JSB00/M0系列
是同ID同算法的重複題目，直接複製既有手寫解答重複使用，不是每題都重新手刻）。

**`hand-author-builder.js`新增3個原生Scratch積木primitive**（M0~M1-10都沒用到，
M1-07排序系列跟M1-11堆疊佇列系列才第一次需要）：
- `replaceItemOfList(b, parent, listId, listName, indexInput, itemInput)`
  （`data_replaceitemoflist`，交換排序需要原地覆寫清單元素）
- `deleteItemOfList(b, parent, listId, listName, indexInput)`
  （`data_deleteoflist`，堆疊pop/佇列dequeue需要真正刪除元素）
- `lengthOfList(b, parent, listId, listName)`
  （`data_lengthoflist`，堆疊佇列模擬需要動態查詢目前清單長度，不能像其他題目
  一樣全程依賴固定的N變數）

**已加進`build-m0-course-sb3.js`/`verify-m0-course.js`/`gen-judge-content.js`的
`COURSE_FILES`**：`M1-01-ListSearch.js`~`M1-12-DebugFormat.js`全部12個檔案（緊接在
`M0-06-MinMaxExtra.js`之後、`JSB00.js`之前）。**這三份腳本的`COURSE_FILES`陣列務必
保持逐字一致**——這是既有規則，這次也照做了。

**已commit+push+deploy**：commit `7b73530`「新增M1系列完整課程（12個檔案共105題），
全部附上驗證過的參考解答」，已push到GitHub、`npm run build`+`npm run deploy`，
GitHub Pages（`https://p2766602-beep.github.io/osep-judge/`）重新確認回傳HTTP 200。
**YDWS-CodingBank canonical課程JS本身這次沒有被修改**（M1系列課程內容本來就已經在
canonical資料夾裡，這次只是幫osep-judge補上示範解答跟上架），所以BlocklyYdws/
blockly-lab不需要因為這次工作額外commit/deploy。

## 已知待辦（依優先度）

1. **`gh auth login`**：使用者親自執行。
2. 本機資料夾改名（`osep-scratch-judge`→`osep-judge`）：已完成，路徑就是`D:\yosep\osep-judge`。

## 範圍政策變更（2026-08-20：國小限定 → 國中小並存）

**原本「osep-judge只上國小（M0~M1＋114E）」的範圍收斂決定已被取代**：部分國中老師反映
希望學生也能直接用Scratch介面解題，使用者2026-08-20要求擴大上架**M2、M3、114TCPJ
（國中競賽模式）、114E（國小學習模式）、114J（國中學習模式）**。

**規模評估**：M2（10課程105題）／M3（5課程30題）／114J（16縣市95題，61題有starterXml）／
114E（16縣市90題，66題有starterXml）／114TCPJ（16縣市95題，競賽模式無需示範解答）。
現有通用轉換器`xml-to-scratch.js`只支援M0/M1實際用到的積木子集，完全不支援清單
（`lists_*`）——Blockly清單是「值」（可以當函式參數/運算元傳遞），Scratch清單是「舞台層級
具名資料結構」（沒有清單值插槽），兩者沒辦法用通用規則自動互轉。掃描發現這批課程清單
使用率很重（M3 93%、M2 63%、114J 44%、114E 32%），估計**至少142題需要逐題手刻Scratch
示範解答**（沿用`hand-author-builder.js`模式，不是延伸轉換器就能解決），比M0+M1加起來
的手刻量大很多。已跟使用者確認**分階段進行、每階段完成後回報確認**，順序：

1. **114TCPJ（已完成）**：純資料搬遷，比照114TCPE模式，不需要示範解答。
2. **114J＋114E（已完成，2026-08-20）**：見下方詳述。**實際手刻量遠低於原本估計的142題**
   ——原本以為清單一定要逐題手刻，後來設計出「清單變數1:1對應成同名Scratch原生清單」的
   通用轉換策略（見`xml-to-scratch.js`檔頭註解），313題有starterXml的題目裡，**只有5題**
   真的需要放棄自動轉換（都集中在114ETaichung，用到`text_getSubstring`/`text_prompt_ext`/
   `controls_flow_statements`/`math_constrain`這幾種語料庫裡只出現個位數次的積木類型，
   評估後決定不擴充轉換器去湊，這幾題就沒有示範解答）。
3. **M2、M3（已完成，2026-08-20）**：見下方「Phase 3」段落。

**114TCPJ完成內容**：`gen-judge-content.js`／`build-m0-course-sb3.js`的`COURSE_FILES`
新增`114TCPJ01.js`~`114TCPJ16.js`（比照114TCPE系列註解與模式）。`verify-m0-course.js`
依既有慣例故意不加（沒有starterXml/示範解答，沒東西可驗證）。跑`build-m0-course-sb3.js`
確認186題（含既有114TCPE系列）全部落進`[SKIP]`分支、0個失敗，重新產生`judge-content.js`
（52課程371題）。

**114J＋114E完成內容**：`xml-to-scratch.js`大幅擴充，新支援的積木類型與轉換策略見該檔案
檔頭註解，重點記錄兩個過程中抓到的真bug（都已修好，未來如果再擴充轉換器要留意這兩類坑）：

- **`lists_setIndex`欄位名稱搞錯**：一開始誤以為「要塞進清單的新值」欄位叫`VALUE`（跟
  `variables_set`同名習慣），實際Blockly標準欄位名稱是`TO`。這個bug不會讓轉換器報錯
  （`VALUE`欄位不存在時`convertValueInput`會安靜地回傳空字串），而是**靜默寫入錯誤資料**
  ——症狀是示範解答執行不會crash，但輸出結果全部不對，只有真的跑headless驗證比對正確答案
  才抓得到，光看轉換有沒有丟例外看不出來。
- **`ctx.pending`跨遞迴呼叫狀態外洩**：`logic_ternary`等「hoist成暫時變數」的積木用
  `ctx.pending`佇列讓外層statement鏈知道要在前面插入額外積木，但`convertStatementChain`
  會遞迴呼叫自己處理迴圈/條件式的body——如果不在遞迴呼叫前後save/restore `ctx.pending`，
  body內部處理完自己的pending後殘留的狀態會被外層誤當成「這個statement自己的pending」
   重複執行一次，導致積木圖出現循環參照（實際測到`RangeError: Maximum call stack size
  exceeded`）。修法：`convertStatementChain`進入時save目前的`ctx.pending`、離開前
  restore回去，讓遞迴呼叫對呼叫端保持透明。

驗證結果：313題有starterXml的題目，308題自動轉換成功且headless驗證（`verify-m0-course.js`）
逐筆比對testCases全部正確（0個功能性錯誤），5題（114ETaichung幾題＋1題巢狀清單）
在轉換階段就直接丟錯、被跳過，不影響其他題目。重新產生`judge-content.js`：
**84課程、556題**。已在正式站（`p2766602-beep.github.io/osep-judge`）實測114EYunlin的
「身體質量指數計算與健康判斷」（BMI，無迴圈/清單）：解鎖課程、載入範例、評分100/100，
約10秒內完成。114JTaipei的「探險隊員名單排序」（排序演算法，實際用到清單＋巢狀迴圈）
也實測積木正確載入到畫布，但**在瀏覽器分頁評分明顯比headless慢很多**（等了30秒以上還在
「評分中」，最後直接關閉分頁沒有真的等到結果）——這不是這次轉換出來的答案有問題（同一份
.sb3已經被headless驗證10/10通過），是Scratch VM本身非turbo模式逐格執行的特性：迴圈/清單
操作愈多，真實瀏覽器分頁跑起來就愈慢，跟M1系列既有的排序/堆疊佇列題目（已經上線很久）
是同樣的既有限制，不是Phase 2新產生的問題。**如果之後有老師反映「評分跑很久」，先確認
題目是不是迴圈/清單較重的類型，這是Scratch平台本身的已知特性，不用當成bug處理。**

**部署時的插曲**：`npm run build`+`npm run deploy`跑完一次後，直接用瀏覽器fetch比對本機
`build/`資料夾與正式站實際回傳的JS bundle hash，發現兩者不一致（正式站當下serve的是舊版
bundle），重跑一次`npm run build`+`npm run deploy`後才一致。原因不明（可能是部署當下
GitHub Pages CDN還沒完全生效，也可能是build/deploy時序上的偶發問題），**以後deploy完
如果測試結果跟預期不符，先直接比對`build/js/pentapod/editor.*.js`的hash跟正式站
`document.scripts`實際載入的hash是否一致，不要照著舊的假設（例如以為單純是瀏覽器快取）
就跳過這一步**。

## Phase 3：M2＋M3上架（2026-08-20完成）

範圍政策變更後的第三階段。使用者先要求討論而不是直接動手，討論了兩個問題：

1. **Turbo模式**：Phase 2發現迴圈/清單重的題目在真實瀏覽器分頁評分很慢，討論後確認
   根因（見上方Phase 2段落），決定開啟`vm.setTurboMode(true)`——已加進
   `tw-judge-engine.js`的`prepareVmForGrading()`（評分路徑）跟`judge-panel.jsx`的
   `SelfTestTab.handleStart()`（自行測試路徑），只影響執行速度不影響邏輯結果，已部署。
   **這個改動在瀏覽器自動化環境裡沒辦法可靠驗證有多快**（懷疑CDP操作的分頁沒有真正
   取得瀏覽器焦點、被Chrome背景節流影響，跟這次改動本身無關）——已請使用者親自用
   `114JTaipei`課程的「探險隊員名單排序」題實測，不確定使用者測試結果前，不要假設
   turbo模式已經完全解決真實使用情境下的速度問題。
2. **M2/M3自動轉換可行性**：正式上架前先跑過一次**不留痕跡的診斷**（暫時把M2/M3
   加進三支腳本的`COURSE_FILES`、跑build+headless verify看數字、確認完再revert，
   sb3產出物也清掉）——這個手法之後如果要評估其他還沒上架的課程群組，可以直接照搬。
   診斷第一輪135題有91題卡在同一個原因：`lists_setIndex`用`MODE=INSERT/WHERE=LAST`
   （插在最後＝附加到清單尾端），這是Phase 2完全沒踩過的模式（114J/114E的`lists_setIndex`
   永遠是`MODE=SET/WHERE=FROM_START`）。補上這個分支（直接對應`data_addtolist`）後
   91題全過；剩下1題（M2-04「大風吹搶位子」）是`lists_getIndex`的`MODE=GET_REMOVE`
   （取值同時移除），用跟`logic_ternary`一樣的hoist手法補上（先存值進暫時變數、
   接著刪除該索引、讀暫時變數當回傳值）。兩個都是`xml-to-scratch.js`的一般性改動，
   純新增分支，對已上線課程零影響。

使用者確認討論結果後**一次全部上架**（不是再分小階段）。`gen-judge-content.js`／
`build-m0-course-sb3.js`／`verify-m0-course.js`三支腳本的`COURSE_FILES`都加上
`M2-01-CondBasics.js`~`M2-10-GreedyAdvanced.js`＋`M3-00-BinarySearchWarmup.js`~
`M3-04-DPWarmup.js`共15個檔案（`verify-m0-course.js`這次也加，因為M2/M3有真正的
示範解答可以驗證，跟114TCPE/114TCPJ純競賽模式不同）。

驗證結果：135題全部starterXml、**135題自動轉換成功、headless驗證135題全數功能正確
（0個功能性錯誤）**，跟診斷階段數字完全一致。重新產生`judge-content.js`：
**99課程、691題**。已commit+build+deploy，部署後照Phase 2學到的教訓比對過
`build/js/pentapod/editor.*.js`跟正式站實際載入的hash確認一致。

## 重要環境注意事項

- **Chrome Remote Desktop（CRD）開著時，Claude的瀏覽器自動化工具（`claude-in-chrome`）
  會連不到這台電腦的localhost**（能連外部網站，但連不到本機dev server），需要視覺驗證前
  務必先確認使用者有沒有開著CRD、請先斷開。完整除錯過程跟已排除的假設見私有記憶
  `feedback_chrome_remote_desktop_conflicts_with_browser_automation.md`，不用重新從頭排查。
- 這台是**學校電腦**（`DESKTOP-GVEE6GT`），YOSEP其餘三個子專案換電腦時的雙電腦同步規則
  （見根目錄`CLAUDE.md`）同樣適用於這裡：換機器要記得`git pull`同步。
