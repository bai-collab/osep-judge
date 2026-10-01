// 頂端選單列的學生代號與導師連線控制；兩者都只讀取共用 store。
/* eslint-disable react/jsx-no-literals, react/jsx-no-bind */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {useStudentIdentity, validStudentId} from '../../lib/learning-records.js';
import {useTutorConnection} from '../../lib/tutor-connection.js';
import styles from './menu-bar.css';

const StudentCodeControl = () => {
    const {studentId, setStudentId} = useStudentIdentity();
    const [editing, setEditing] = useState(() => !validStudentId(studentId));
    const expanded = editing || !validStudentId(studentId);
    const inputRef = useRef(null);
    const collapsedButtonRef = useRef(null);
    const previousExpandedRef = useRef(expanded);
    const handleStudentCode = useCallback(event => setStudentId(event.target.value.trim()), [setStudentId]);

    useEffect(() => {
        if (expanded) {
            if (inputRef.current) inputRef.current.focus();
        } else if (previousExpandedRef.current && collapsedButtonRef.current) {
            collapsedButtonRef.current.focus();
        }
        previousExpandedRef.current = expanded;
    }, [expanded]);

    return (
        <div className={styles.osepControlItem}>
            {expanded ? (
                <span className={styles.osepControlLabel}>{'學生代號'}</span>
            ) : (
                <button
                    aria-controls="student-code-panel"
                    aria-expanded={false}
                    className={styles.osepControlButton}
                    ref={collapsedButtonRef}
                    type="button"
                    onClick={() => setEditing(true)}
                >
                    <span className={styles.osepControlWideLabel}>{`學生代號：${studentId}`}</span>
                    <span className={styles.osepControlShortLabel}>{`代號：${studentId}`}</span>
                    <span>{'［修改］'}</span>
                </button>
            )}
            {expanded && (
                <div
                    aria-label="學生代號設定"
                    className={`${styles.osepPanel} ${styles.osepStudentPanel}`}
                    id="student-code-panel"
                    role="region"
                >
                    <p
                        className={styles.osepWarning}
                        role="status"
                    >
                        <strong>{validStudentId(studentId) ? '確認學生代號' : '請先填寫學生代號'}</strong>
                        {!validStudentId(studentId) && <span>{'未填代號，提問與評分不會保存。'}</span>}
                    </p>
                    <label htmlFor="student-code">{'學生代號（例如 S01）'}</label>
                    <input
                        aria-describedby="student-code-help"
                        aria-invalid={Boolean(studentId) && !validStudentId(studentId)}
                        id="student-code"
                        maxLength={40}
                        ref={inputRef}
                        placeholder="例如：S01"
                        value={studentId}
                        onChange={handleStudentCode}
                    />
                    <p id="student-code-help">
                        {'可用中英文字、數字、底線或減號，1～40 字元，不含空白。'}
                    </p>
                    <button
                        className={styles.osepConfirmButton}
                        disabled={!validStudentId(studentId)}
                        type="button"
                        onClick={() => setEditing(false)}
                    >{'確認代號'}</button>
                </div>
            )}
        </div>
    );
};

const ConnectionControl = () => {
    const connection = useTutorConnection();
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const modeRef = useRef(null);
    const closePanel = useCallback(() => {
        setOpen(false);
        if (triggerRef.current) triggerRef.current.focus();
    }, []);

    useEffect(() => {
        if (!open) return () => {};
        if (modeRef.current) modeRef.current.focus();
        const handlePointerDown = event => {
            if (rootRef.current && !rootRef.current.contains(event.target)) closePanel();
        };
        const handleKeyDown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closePanel();
            }
        };
        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [closePanel, open]);

    const status = connection.statusReady ? (connection.managed ?
        `教師設定：AI ${connection.aiConfigured ? '已設定' : '尚未設定'}。` :
        '目前服務未使用教師管理設定。') : '正在確認教師設定…';

    return (
        <div
            className={styles.osepControlItem}
            ref={rootRef}
        >
            <button
                aria-controls="tutor-connection-panel"
                aria-expanded={open}
                aria-haspopup="dialog"
                className={styles.osepControlButton}
                ref={triggerRef}
                type="button"
                onClick={() => {
                    if (open) closePanel();
                    else setOpen(true);
                }}
            >
                <span className={styles.osepControlWideLabel}>{'連線設定'}</span>
                <span className={styles.osepControlShortLabel}>{'連線'}</span>
            </button>
            {open && (
                <div
                    aria-label="連線設定"
                    className={styles.osepPanel}
                    id="tutor-connection-panel"
                    role="dialog"
                >
                    <label htmlFor="tutor-mode">{'導師模式'}</label>
                    <select
                        id="tutor-mode"
                        ref={modeRef}
                        value={connection.mode}
                        onChange={event => connection.setMode(event.target.value)}
                    >
                        <option value="mock">{'模擬練習'}</option>
                        <option value="live">{'NMKING 真實模型'}</option>
                    </select>
                    <p aria-live="polite">{status}</p>
                    <a
                        href="/teacher.html"
                        rel="noopener noreferrer"
                        target="_blank"
                    >{'前往教師設定頁'}</a>
                </div>
            )}
        </div>
    );
};

const TutorControls = () => (
    <div className={styles.osepControls}>
        <StudentCodeControl />
        <ConnectionControl />
    </div>
);

export {StudentCodeControl, ConnectionControl};
export default TutorControls;
