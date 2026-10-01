// 本機繁體中文介面；hook元件沿用導師的事件回呼形式。
/* eslint-disable react/jsx-no-literals, react/jsx-no-bind */
import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import PropTypes from 'prop-types';
import {clampTutorRect, initialTutorRect, resizeTutorRect} from '../../lib/tutor-window-geometry.js';
import styles from './floating-tutor.css';

const viewport = () => ({width: window.innerWidth, height: window.innerHeight});
const directions = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};

const FloatingTutor = ({children, mode, open, minimized, onClose, onMinimize, onRestore}) => {
    const [everOpened, setEverOpened] = useState(open);
    const [rect, setRect] = useState(() => initialTutorRect(viewport()));
    const interaction = useRef(null);
    const moveRef = useRef(null);
    const dockRef = useRef(null);

    useEffect(() => {
        const handleViewportResize = () => setRect(current => clampTutorRect(current, viewport()));
        window.addEventListener('resize', handleViewportResize);
        return () => window.removeEventListener('resize', handleViewportResize);
    }, []);

    useEffect(() => {
        interaction.current = null;
        if (open) {
            setEverOpened(true);
            const target = minimized ? dockRef.current : moveRef.current;
            if (target) target.focus();
        }
    }, [open, minimized]);

    const handlePointerStart = (event, kind) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        interaction.current = {kind, id: event.pointerId, x: event.clientX, y: event.clientY, rect};
    };
    const handlePointerMove = event => {
        const start = interaction.current;
        if (!start || start.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        setRect(start.kind === 'resize' ? resizeTutorRect(start.rect, dx, dy, viewport()) :
            clampTutorRect({...start.rect, x: start.rect.x + dx, y: start.rect.y + dy}, viewport()));
    };
    const handlePointerEnd = event => {
        if (!interaction.current || interaction.current.id !== event.pointerId) return;
        interaction.current = null;
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const handleLostCapture = () => {
        interaction.current = null;
    };
    const handleArrow = (event, kind) => {
        const direction = directions[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 40 : 10;
        const [dx, dy] = direction.map(value => value * step);
        setRect(current => (kind === 'resize' ? resizeTutorRect(current, dx, dy, viewport()) :
            clampTutorRect({...current, x: current.x + dx, y: current.y + dy}, viewport())));
    };
    const handleEscape = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
        }
    };

    if (!everOpened && !open) return null;
    // 始終掛載本題內容，隱藏浮窗不會重建導師或清除草稿／對話。
    return createPortal(
        <React.Fragment>
            <div
                className={styles.window}
                aria-labelledby="floating-tutor-title"
                aria-modal="false"
                hidden={!open || minimized}
                id="floating-tutor-window"
                role="dialog"
                style={{left: rect.x, top: rect.y, width: rect.width, height: rect.height}}
                onKeyDown={handleEscape}
            >
                <div className={styles.titlebar}>
                    <button
                        className={styles.moveHandle}
                        aria-label="移動解題導師視窗"
                        ref={moveRef}
                        title="拖曳移動；方向鍵也可移動"
                        type="button"
                        onKeyDown={event => handleArrow(event, 'move')}
                        onLostPointerCapture={handleLostCapture}
                        onPointerCancel={handlePointerEnd}
                        onPointerDown={event => handlePointerStart(event, 'move')}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerEnd}
                    >
                        <strong id="floating-tutor-title">解題導師</strong>
                        <span>{`${mode === 'live' ? 'NMKING 真實模型' : '模擬練習'} · 拖曳這裡移動`}</span>
                    </button>
                    <button
                        className={styles.control}
                        aria-label="縮小解題導師"
                        title="縮小"
                        type="button"
                        onClick={onMinimize}
                    >─</button>
                    <button
                        className={styles.control}
                        aria-label="關閉解題導師"
                        title="關閉，保留本題對話"
                        type="button"
                        onClick={onClose}
                    >×</button>
                </div>
                <div className={styles.content}>{children}</div>
                <div className={styles.resizeBar}>
                    <span>右下角可調整大小</span>
                    <button
                        className={styles.resizeHandle}
                        aria-label="調整解題導師視窗大小"
                        title="拖曳調整大小；方向鍵也可調整"
                        type="button"
                        onKeyDown={event => handleArrow(event, 'resize')}
                        onLostPointerCapture={handleLostCapture}
                        onPointerCancel={handlePointerEnd}
                        onPointerDown={event => handlePointerStart(event, 'resize')}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerEnd}
                    >↘</button>
                </div>
            </div>
            <button
                className={styles.dock}
                hidden={!open || !minimized}
                ref={dockRef}
                type="button"
                onClick={onRestore}
                onKeyDown={handleEscape}
            >展開解題導師</button>
        </React.Fragment>, document.body
    );
};

FloatingTutor.propTypes = {
    children: PropTypes.node.isRequired,
    mode: PropTypes.oneOf(['mock', 'live']).isRequired,
    minimized: PropTypes.bool.isRequired,
    onClose: PropTypes.func.isRequired,
    onMinimize: PropTypes.func.isRequired,
    onRestore: PropTypes.func.isRequired,
    open: PropTypes.bool.isRequired
};

export default FloatingTutor;
