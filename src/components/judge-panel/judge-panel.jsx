import React, {useState, useEffect, useRef, useCallback} from 'react';
import PropTypes from 'prop-types';
import VM from 'scratch-vm';
import {gradeSubmission, prepareVmForGrading} from '../../lib/tw-judge-engine.js';
import {scaffoldUrlForCourse} from '../../lib/scaffold-content.js';
import judgeManualRun from '../../lib/judge-manual-run.js';
import TaskList, {CourseTaskList} from './task-list.jsx';
import TutorTab from './tutor-tab.jsx';
import FloatingTutor from './floating-tutor.jsx';
import {useTutorConnection} from '../../lib/tutor-connection.js';
import styles from './judge-panel.css';
import {useStudentIdentity, validStudentId, newRecordId, safeProgram,
    recordingText, postGradeRecord} from '../../lib/learning-records.js';

/**
 * MVP-33後續：題目面板，仿官方平台(demo.csie.ntnu.edu.tw/ps)的
 * 說明/自行測試/評分/評分紀錄四分頁版面，加上方案C的課程/題目瀏覽清單
 * （取代BlocklyYdws的courseCode輸入代碼方式）。
 */

const TABS = [
    {id: 'description', label: '說明'},
    {id: 'selftest', label: '自行測試'},
    {id: 'grading', label: '評分'},
    {id: 'history', label: '評分紀錄'}
];

const HISTORY_STORAGE_KEY_PREFIX = 'osepJudgeHistory:';

// 累計造訪次數計數器（純統計用途，不記錄任何個人資訊）。
const VISIT_COUNTER_URL = 'https://osep-judge-visit-counter.tnjboxing.workers.dev/hit';

const loadHistory = taskCode => {
    try {
        const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY_PREFIX + taskCode);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
};

const saveHistoryEntry = (taskCode, entry) => {
    const history = [entry, ...loadHistory(taskCode)].slice(0, 50);
    try {
        window.localStorage.setItem(HISTORY_STORAGE_KEY_PREFIX + taskCode, JSON.stringify(history));
    } catch (e) {
        // localStorage不可用或已滿，忽略，不影響評分本身
    }
    return history;
};

/**
 * 評分/自行測試前後保存並還原每個角色的visible狀態（見tw-judge-engine.js的visible陷阱說明），
 * 避免影響學生原本編輯畫面。
 */
const withVisibilityRestore = async (vm, fn) => {
    const previousVisibility = vm.runtime.targets.map(target => ({target, visible: target.visible}));
    try {
        prepareVmForGrading(vm);
        return await fn();
    } finally {
        previousVisibility.forEach(({target, visible}) => {
            target.visible = visible;
        });
    }
};

const DescriptionTab = ({task, onLoadDemo, demoStatus, demoLoaded, scaffoldUrl}) => (
    <div className={styles.tabContent}>
        <h3 className={styles.sectionHeading}>題目敘述</h3>
        <p className={styles.description}>{task.description}</p>
        {scaffoldUrl ? (
            <a
                className={styles.scaffoldLink}
                href={scaffoldUrl}
                rel="noopener noreferrer"
                target="_blank"
            >
                📘 延伸學習：這個主題的概念補充文件
            </a>
        ) : null}
        <h3 className={styles.sectionHeading}>範例測資</h3>
        {task.examples.map((example, index) => (
            <div className={styles.exampleBox} key={index}>
                <div className={styles.exampleLabel}>範例 {index + 1}</div>
                <table className={styles.exampleTable}>
                    <tbody>
                        <tr>
                            <th>輸入</th>
                            <td className={styles.exampleValue}>{example.input}</td>
                        </tr>
                        <tr>
                            <th>輸出</th>
                            <td className={styles.exampleValue}>{example.output}</td>
                        </tr>
                        {example.explanation ? (
                            <tr>
                                <th>說明</th>
                                <td className={styles.exampleExplanation}>{example.explanation}</td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
        ))}
        {task.loadable ? (
            <React.Fragment>
                <button
                    className={demoLoaded ? styles.demoButtonLoaded : styles.demoButton}
                    onClick={onLoadDemo}
                >
                    {demoLoaded ? '✓ 已載入範例答案' : '載入範例'}
                </button>
                {demoStatus ? (
                    <div className={styles.demoStatus}>{demoStatus}</div>
                ) : null}
            </React.Fragment>
        ) : null}
    </div>
);
DescriptionTab.propTypes = {
    demoLoaded: PropTypes.bool,
    demoStatus: PropTypes.string,
    onLoadDemo: PropTypes.func.isRequired,
    scaffoldUrl: PropTypes.string,
    task: PropTypes.shape({
        description: PropTypes.string,
        examples: PropTypes.array,
        loadable: PropTypes.bool
    }).isRequired
};

/**
 * 2026-08-04：改成跟正式Scratch/官方競賽平台一樣的「手動測試」操作方式——按下開始後
 * 畫面右下角跳出真正的Scratch舞台，「詢問並等待」會跳出原生輸入框，一筆一筆手動輸入，
 * 不是像「評分」那樣一次把全部測資塞進一個字串自動跑完。這是刻意跟「評分」分開的兩種
 * 輸入模式（手動測試給學生用、評分給系統自動讀取），對齊國小學生已經熟悉的Scratch
 * 操作習慣（見judge-manual-run.js的說明——舞台平常用CSS隱藏，這裡暫時顯示出來）。
 */
const SelfTestTab = ({vm}) => {
    const [running, setRunning] = useState(false);
    const [output, setOutput] = useState(null);
    const [debugOutput, setDebugOutput] = useState(null);
    // 用ref存這次執行的攔截狀態（onSay handler／目前累積的說出／輸出訊息／輪詢計時器），
    // 讓poll的setInterval跟handleStop都能拿到同一份、不受React重新render影響。
    const runStateRef = useRef(null);

    const restoreVisibility = state => {
        if (!state || !state.previousVisibility) return;
        state.previousVisibility.forEach(({target, visible}) => {
            target.visible = visible;
        });
    };

    const finishRun = () => {
        const state = runStateRef.current;
        if (!state) return;
        clearInterval(state.poll);
        vm.runtime.off('SAY', state.onSay);
        restoreVisibility(state);
        runStateRef.current = null;
        setOutput(state.capturedSay.join('\n'));
        setDebugOutput(state.capturedThink.join('\n'));
        setRunning(false);
        judgeManualRun.hide();
    };

    useEffect(() => () => {
        // 離開這個分頁/切換題目時，如果手動測試還在跑，把舞台藏回去、程式停掉、
        // 解除監聽、還原visible狀態，不要留著浮動視窗跟背景執行的程式。
        judgeManualRun.hide();
        vm.stopAll();
        if (runStateRef.current) {
            vm.runtime.off('SAY', runStateRef.current.onSay);
            clearInterval(runStateRef.current.poll);
            restoreVisibility(runStateRef.current);
            runStateRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleStart = () => {
        setRunning(true);
        setOutput(null);
        setDebugOutput(null);

        const capturedSay = [];
        const capturedThink = [];
        const onSay = (target, type, text) => {
            if (type === 'say') capturedSay.push(text);
            else if (type === 'think') capturedThink.push(text);
        };
        vm.runtime.on('SAY', onSay);

        // 角色visible要維持false（跟評分用的prepareVmForGrading()一樣），不是true！
        // 這是scratch-vm本身故意設計的行為（node_modules/scratch-vm/src/blocks/
        // scratch3_sensing.js的_askNextQuestion()）：target.visible===true時，
        // 「詢問並等待」會emit空字串給QUESTION事件、改用SAY事件把問題文字echo成角色
        // 頭上的說話泡泡（畫在舞台canvas上）；但我們的舞台canvas本來就故意用minimal
        // 模式藏起來（只留輸入框），如果visible=true，問題文字會echo到「看不見的地方」，
        // 學生會看到一個沒有題目文字的空白輸入框。維持visible=false，問題文字才會直接
        // 放進輸入框上方的label（Question元件自己畫的，不依賴舞台canvas），這正是minimal
        // 模式下唯一看得到問題文字的地方。已實測驗證過這個因果關係。
        // 跑完/停止後會還原回原本的visible狀態（見restoreVisibility），不留副作用。
        const previousVisibility = vm.runtime.targets.map(target => ({target, visible: target.visible}));
        vm.runtime.targets.forEach(target => {
            if (!target.isStage) target.visible = false;
        });
        // 跟評分路徑（tw-judge-engine.js的prepareVmForGrading()）一樣開turbo模式，
        // 原因見那邊的註解——只影響迴圈/清單較重的程式跑多快，不影響「詢問並等待」
        // 真正等待學生輸入的行為（那是真的非同步等待，turbo模式不會跳過）。
        vm.setTurboMode(true);
        judgeManualRun.show();
        vm.greenFlag();

        const poll = setInterval(() => {
            if (vm.runtime.threads.length === 0) {
                finishRun();
            }
        }, 200);
        runStateRef.current = {onSay, capturedSay, capturedThink, poll, previousVisibility};
    };

    const handleStop = () => {
        vm.stopAll();
        finishRun();
    };

    return (
        <div className={styles.tabContent}>
            <p className={styles.placeholder}>
                按下「開始手動測試」，畫面右下角會跳出跟正式Scratch一樣的舞台——「詢問並等待」
                會跳出輸入框讓你一筆一筆手動輸入作答（不是自動帶入）。不計分、不比對答案，
                純粹讓你看看程式實際執行的樣子。
            </p>
            {running ? (
                <button
                    className={styles.runButton}
                    onClick={handleStop}
                >
                    停止（隱藏舞台）
                </button>
            ) : (
                <button
                    className={styles.runButton}
                    onClick={handleStart}
                >
                    開始手動測試
                </button>
            )}
            {output !== null ? (
                <React.Fragment>
                    <h3 className={styles.sectionHeading}>輸出：（「說出」的內容，系統評分依據）</h3>
                    <div className={styles.selfTestOutput}>
                        {output || '（沒有任何「說出」內容）'}
                    </div>
                </React.Fragment>
            ) : null}
            {debugOutput ? (
                <React.Fragment>
                    <h3 className={styles.sectionHeading}>訊息：（「輸出至訊息視窗」積木，不計分）</h3>
                    <div className={styles.selfTestOutput}>{debugOutput}</div>
                </React.Fragment>
            ) : null}
        </div>
    );
};
SelfTestTab.propTypes = {
    vm: PropTypes.instanceOf(VM).isRequired
};

const GradingTab = ({grading, onRunGrading, demoLoaded}) => (
    <div className={styles.tabContent}>
        {demoLoaded ? (
            <div className={styles.demoWarningBanner}>
                ⚠ 目前畫布上的程式是「載入範例答案」載入的，不是學生自己寫的——這次評分
                （包含之後存進評分紀錄的結果）僅供功能測試參考，不能當作學生作答成績。
            </div>
        ) : null}
        <button
            className={styles.runButton}
            disabled={grading.isRunning}
            onClick={onRunGrading}
        >
            {grading.isRunning ? '評分中…' : '執行評分'}
        </button>
        {grading.results ? (
            <div className={styles.resultsBox}>
                <div className={styles.scoreLine}>
                    分數：{grading.totalScore} / {grading.maxScore}
                </div>
                {grading.results.map((result, index) => (
                    <div
                        className={styles.resultRow}
                        key={index}
                    >
                        <span className={result.pass ? styles.pass : styles.fail}>
                            {result.pass ? '通過' : '未通過'}
                        </span>
                        <span className={styles.resultInput}>輸入：{result.input}</span>
                    </div>
                ))}
            </div>
        ) : null}
        {grading.error ? (
            <div className={styles.errorBox}>評分時發生錯誤：{grading.error}</div>
        ) : null}
    </div>
);
GradingTab.propTypes = {
    demoLoaded: PropTypes.bool,
    grading: PropTypes.shape({
        isRunning: PropTypes.bool,
        totalScore: PropTypes.number,
        maxScore: PropTypes.number,
        results: PropTypes.array,
        error: PropTypes.string
    }).isRequired,
    onRunGrading: PropTypes.func.isRequired
};

const HistoryTab = ({history}) => (
    <div className={styles.tabContent}>
        {history.length === 0 ? (
            <p className={styles.placeholder}>還沒有評分紀錄，去「評分」分頁執行評分後會出現在這裡（存在這台電腦的瀏覽器裡）。</p>
        ) : (
            history.map((entry, index) => (
                <div
                    className={styles.historyItem}
                    key={index}
                >
                    <span>
                        {entry.totalScore} / {entry.maxScore}
                        {entry.demoLoaded ? (
                            <span className={styles.historyDemoTag}>載入範例</span>
                        ) : null}
                    </span>
                    <span className={styles.historyTime}>{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
            ))
        )}
    </div>
);
HistoryTab.propTypes = {
    history: PropTypes.arrayOf(PropTypes.shape({
        totalScore: PropTypes.number,
        maxScore: PropTypes.number,
        timestamp: PropTypes.number,
        demoLoaded: PropTypes.bool
    })).isRequired
};

const JudgePanel = ({vm}) => {
    const [selectedTaskCode, setSelectedTaskCode] = useState(null);
    // 2026-09-05：解完題按「返回」時，記住剛剛那一題屬於哪個課程，回去該課程自己的題目清單，
    // 而不是每次都砍回最上層的全部課程列表（見下面handleBackFromTask）。
    const [viewingCourseCode, setViewingCourseCode] = useState(null);
    const [activeTab, setActiveTab] = useState('description');
    const [tutorOpen, setTutorOpen] = useState(false);
    const [tutorMinimized, setTutorMinimized] = useState(false);
    const tutorOpenerRef = useRef(null);
    const [grading, setGrading] = useState({
        isRunning: false,
        totalScore: null,
        maxScore: null,
        results: null,
        error: null
    });
    const [demoStatus, setDemoStatus] = useState(null);
    const [demoLoaded, setDemoLoaded] = useState(false);
    const [history, setHistory] = useState([]);
    const [visitCount, setVisitCount] = useState(null);
    const {studentId} = useStudentIdentity();
    const [recordStatus, setRecordStatus] = useState('');
    const gradingRunRef = useRef(false);
    const [judgeContent, setJudgeContent] = useState(null);
    const [taskDetail, setTaskDetail] = useState(null);
    const [taskLoading, setTaskLoading] = useState(false);
    // 連線獨立留在本頁記憶體，面板重建、更新積木不會清除。
    const tutorConnection = useTutorConnection();
    const {apiKey: tutorApiKey, mode: tutorMode} = tutorConnection;
    const handleTutorOpen = useCallback(() => {
        setTutorOpen(true);
        setTutorMinimized(false);
    }, []);
    const handleTutorMinimize = useCallback(() => {
        setTutorMinimized(true);
    }, []);
    const handleTutorClose = useCallback(() => {
        setTutorOpen(false);
        setTutorMinimized(false);
        if (tutorOpenerRef.current) tutorOpenerRef.current.focus();
    }, []);

    // judge-content/是課程資料模組（跟平台程式碼本身無關），改成動態載入讓webpack把它切成
    // 獨立chunk：上架新題目只讓對應課程檔案的雜湊變、平台UI改動只讓主程式碼的雜湊變，兩者
    // 互不拖累對方的瀏覽器快取。這裡載入的index.js本身只帶manifest（輕量課程/題目清單），
    // 個別課程的完整資料（description/testCases等）要點進某個題目才會另外動態載入，見下面
    // 針對selectedTaskCode的useEffect。
    useEffect(() => {
        let cancelled = false;
        import(/* webpackChunkName: "judge-content" */ '../../lib/judge-content/index.js').then(mod => {
            if (!cancelled) {
                setJudgeContent({courses: mod.courses, findTaskByCode: mod.findTaskByCode});
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // 使用者選了某個題目後，才動態載入該題目所屬課程的完整資料（description/testCases等）。
    useEffect(() => {
        if (!judgeContent || !selectedTaskCode) {
            setTaskDetail(null);
            setTaskLoading(false);
            return;
        }
        let cancelled = false;
        setTaskLoading(true);
        judgeContent.findTaskByCode(selectedTaskCode).then(found => {
            if (!cancelled) {
                setTaskDetail(found);
                setTaskLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [judgeContent, selectedTaskCode]);

    useEffect(() => {
        let cancelled = false;
        fetch(VISIT_COUNTER_URL, {method: 'POST'})
            .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then(data => {
                if (!cancelled && typeof data.count === 'number') {
                    setVisitCount(data.count);
                }
            })
            .catch(() => {
                // 計數器打不到就靜靜放棄，不影響平台其他功能。
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const task = taskDetail && taskDetail.task.code === selectedTaskCode ? taskDetail.task : null;
    const scaffoldUrl = taskDetail ? scaffoldUrlForCourse(taskDetail.course.code) : null;

    useEffect(() => {
        if (task) {
            setHistory(loadHistory(task.code));
            setActiveTab('description');
            setTutorOpen(false);
            setTutorMinimized(false);
            setGrading({isRunning: false, totalScore: null, maxScore: null, results: null, error: null});
            setDemoStatus(null);
            // 安全性修正（2026-09-05）：這裡以前會把demoLoaded重設為false，但切換題目並不會清空
            // vm畫布（整個檔案只有handleLoadDemo會呼叫vm.loadProject）——若在這裡重設，學生可以
            // 載入範例→切到別題→切回來，畫布還是範例答案，但demoLoaded已顯示false，評分紀錄跟
            // GradingTab的警示banner都會消失，就能把範例答案偽裝成自己的評分結果。demoLoaded只
            // 能在畫布內容真的被替換的地方改（目前就是handleLoadDemo成功時設true），不能跟著
            // 「目前選哪一題」連動。
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task]);

    const handleBackFromTask = () => {
        setViewingCourseCode(taskDetail?.course?.code || null);
        setSelectedTaskCode(null);
    };

    const handleLoadDemo = async () => {
        setDemoStatus('載入中…');
        try {
            const response = await fetch(task.answerProjectUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const buffer = await response.arrayBuffer();
            await vm.loadProject(buffer);
            setDemoStatus('已載入範例答案，可以在左邊積木畫布查看。');
            setDemoLoaded(true);
        } catch (err) {
            setDemoStatus(`載入失敗：${err && err.message ? err.message : String(err)}`);
        }
    };

    const handleRunGrading = async () => {
        if (gradingRunRef.current) return;
        gradingRunRef.current = true;
        const currentTask = task;
        const currentDemo = demoLoaded;
        let record;
        if (validStudentId(studentId)) {
            try {
                const candidate = {
                    id: newRecordId(),
                    studentId,
                    type: 'grade',
                    task: {code: task.code, title: task.title},
                    program: safeProgram(vm, tutorApiKey),
                    demoLoaded: currentDemo
                };
                if (tutorApiKey && JSON.stringify(candidate).includes(tutorApiKey)) {
                    throw new Error('記錄文字含有 API 金鑰；本次不保存紀錄。');
                }
                record = candidate;
            } catch (err) {
                setRecordStatus(err.message);
            }
        } else setRecordStatus(recordingText(null));
        setGrading({
            isRunning: true,
            totalScore: null,
            maxScore: null,
            results: null,
            error: null,
            taskCode: task.code
        });
        try {
            const {totalScore, maxScore, results} = await withVisibilityRestore(
                vm, () => gradeSubmission(vm, currentTask.testCases)
            );
            setGrading({isRunning: false, totalScore, maxScore, results, error: null, taskCode: task.code});
            setHistory(saveHistoryEntry(task.code, {totalScore, maxScore, timestamp: Date.now(), demoLoaded}));
            if (record) {
                let programChanged = true;
                try {
                    programChanged = JSON.stringify(record.program) !== JSON.stringify(safeProgram(vm, tutorApiKey));
                } catch (err) { /* 無法核對時保留未知變更，不當作相同程式。 */ }
                setRecordStatus(await postGradeRecord({
                    ...record,
                    status: 'completed',
                    totalScore,
                    maxScore,
                    programChanged
                }));
            }
        } catch (err) {
            setGrading({
                isRunning: false,
                totalScore: null,
                maxScore: null,
                results: null,
                error: err && err.message ? err.message : String(err)
            });
            if (record) {
                setRecordStatus(await postGradeRecord({...record, status: 'failed', errorCode: 'GRADING_FAILED'}));
            }
        } finally {
            // 每次入口已同步鎖住；finally 無條件釋放，不依賴舊值。
            // eslint-disable-next-line require-atomic-updates
            gradingRunRef.current = false;
        }
    };

    if (!judgeContent) {
        return (
            <div className={styles.judgePanel}>
                <div className={styles.header}>
                    <div className={styles.headerLeft}>
                        <span className={styles.taskTitle}>osep-judge</span>
                    </div>
                </div>
                <div className={styles.tabContent}>
                    <p className={styles.placeholder}>題目資料載入中…</p>
                </div>
            </div>
        );
    }

    if (selectedTaskCode && !task) {
        return (
            <div className={styles.judgePanel}>
                <div className={styles.header}>
                    <div className={styles.headerLeft}>
                        <button
                            className={styles.backButton}
                            onClick={handleBackFromTask}
                        >
                            ← 上一頁
                        </button>
                        <span className={styles.taskTitle}>osep-judge</span>
                    </div>
                </div>
                <div className={styles.tabContent}>
                    <p className={styles.placeholder}>
                        {taskLoading ? '題目資料載入中…' : '找不到這個題目。'}
                    </p>
                </div>
            </div>
        );
    }

    if (!task) {
        // 2026-09-05：從題目詳情頁按「返回」回來時，viewingCourseCode會記著剛剛那一題的課程
        // 代碼——只要manifest裡找得到這個課程，就顯示該課程自己的題目清單，不要每次都砍回
        // 最上層的全部課程列表（見上面的handleBackFromTask）。
        const viewingCourse = viewingCourseCode
            ? judgeContent.courses.find(course => course.code === viewingCourseCode)
            : null;

        return (
            <div className={styles.judgePanel}>
                <div className={styles.header}>
                    <div className={styles.headerLeft}>
                        <span className={styles.taskTitle}>osep-judge</span>
                    </div>
                    {visitCount !== null && (
                        <span className={styles.visitCounter}>累計造訪次數：{visitCount}</span>
                    )}
                </div>
                {viewingCourse ? (
                    <CourseTaskList
                        course={viewingCourse}
                        onBack={() => setViewingCourseCode(null)}
                        onSelectTask={setSelectedTaskCode}
                    />
                ) : (
                    <TaskList
                        courses={judgeContent.courses}
                        onSelectTask={setSelectedTaskCode}
                    />
                )}
            </div>
        );
    }

    const scoreLabel = grading.totalScore === null ? '尚未評分' : `${grading.totalScore} / ${grading.maxScore}`;

    return (
        <React.Fragment>
            <div className={styles.judgePanel}>
                <div className={styles.header}>
                    <div className={styles.headerLeft}>
                        <button
                            className={styles.backButton}
                            onClick={handleBackFromTask}
                        >
                            ← 上一頁
                        </button>
                        <span className={styles.taskTitle}>{task.title}</span>
                        {demoLoaded ? (
                            <span className={styles.headerDemoTag}>載入範例中</span>
                        ) : null}
                    </div>
                    <div className={styles.headerRight}>
                        {visitCount !== null && (
                            <span className={styles.visitCounter}>累計造訪次數：{visitCount}</span>
                        )}
                        <span className={styles.scoreBadge}>{scoreLabel}</span>
                    </div>
                </div>
                <div className={styles.tabBar}>
                    {TABS.map(tab => (
                        <button
                            className={activeTab === tab.id ? styles.tabButtonActive : styles.tabButton}
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                    <button
                        className={tutorOpen ? styles.tabButtonActive : styles.tabButton}
                        aria-controls="floating-tutor-window"
                        aria-expanded={tutorOpen && !tutorMinimized}
                        aria-haspopup="dialog"
                        ref={tutorOpenerRef}
                        type="button"
                        onClick={handleTutorOpen}
                    >{'解題導師'}</button>
                </div>
                {recordStatus && <p
                    className={styles.recordNotice}
                    aria-live="polite"
                >{recordStatus}</p>}
                {activeTab === 'description' && (
                    <DescriptionTab
                        demoLoaded={demoLoaded}
                        demoStatus={demoStatus}
                        scaffoldUrl={scaffoldUrl}
                        task={task}
                        onLoadDemo={handleLoadDemo}
                    />
                )}
                {activeTab === 'selftest' && <SelfTestTab vm={vm} />}
                {activeTab === 'grading' && (
                    <GradingTab
                        demoLoaded={demoLoaded}
                        grading={grading}
                        onRunGrading={handleRunGrading}
                    />
                )}
                {activeTab === 'history' && <HistoryTab history={history} />}
            </div>
            <FloatingTutor
                key={task.code}
                minimized={tutorMinimized}
                mode={tutorMode}
                open={tutorOpen}
                onClose={handleTutorClose}
                onMinimize={handleTutorMinimize}
                onRestore={handleTutorOpen}
            >
                <TutorTab
                    apiKey={tutorApiKey}
                    connection={tutorConnection}
                    grading={grading.taskCode === task.code ? grading : null}
                    key={task.code}
                    mode={tutorMode}
                    task={task}
                    visible={tutorOpen && !tutorMinimized}
                    vm={vm}
                />
            </FloatingTutor>
        </React.Fragment>
    );
};

JudgePanel.propTypes = {
    vm: PropTypes.instanceOf(VM).isRequired
};

export default JudgePanel;
