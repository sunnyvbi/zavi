import React from 'react';
import type { ChatBeat, StatusDot } from '../brief';
import type { Theme } from '../theme';
import { Monogram, monogramOf } from '../glyphs';
import { ContentStage, useEntrance } from './kit';

const DOT_COLOR: Record<StatusDot, string> = {
  green: '#2F9E6E',
  amber: '#D8923B',
  red: '#C75C4E',
  blue: '#3C7DD6',
};
const dotColor = (s: StatusDot | undefined): string => DOT_COLOR[s as StatusDot] ?? DOT_COLOR.green;

const ChatCard: React.FC<{
  msg: ChatBeat['messages'][number];
  theme: Theme;
  appear: number;
  dx: number;
  width: number;
}> = ({ msg, theme, appear, dx, width }) => {
  const L = theme.light;
  const e = useEntrance(appear, { rise: 24, scaleFrom: 0.975, motion: theme.motion });
  if (e.s < 0.001) return null;

  const monoBg = msg.accent ?? theme.brand.accent;
  const reply = msg.reply;

  return (
    <div
      style={{
        width,
        marginLeft: dx,
        opacity: e.opacity,
        transform: `translateY(${e.translateY}px)`,
        background: L.card,
        borderRadius: 14,
        boxShadow: theme.shadow.card,
        border: `1px solid ${L.hairline}`,
        padding: '24px 28px',
        display: 'flex',
        gap: 18,
        alignItems: 'flex-start',
      }}
    >
      <Monogram label={msg.monogram ?? monogramOf(msg.speaker)} size={48} bg={monoBg} radius={11} fontFamily={theme.fonts.sans} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: theme.fonts.sans, fontWeight: 600, fontSize: 22, color: L.ink }}>
            {msg.speaker}
          </span>
          {reply?.badge && (
            <span
              style={{
                ...theme.type.meta,
                fontWeight: 700,
                color: L.faint,
                background: L.cardSoft,
                border: `1px solid ${L.hairline}`,
                borderRadius: 5,
                padding: '2px 7px',
              }}
            >
              {reply.badge}
            </span>
          )}
          {reply?.role && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {reply.statusDot && (
                <span
                  style={{ width: 9, height: 9, borderRadius: 5, background: dotColor(reply.statusDot) }}
                />
              )}
              <span style={{ ...theme.type.meta, fontWeight: 500, color: L.sub }}>{reply.role}</span>
            </span>
          )}
        </div>

        {msg.body && (
          <div style={{ marginTop: 10, fontFamily: theme.fonts.sans, fontSize: 22, lineHeight: 1.4, color: L.sub }}>
            {msg.mention && (
              <span style={{ color: theme.light.accentText, fontWeight: 600 }}>{msg.mention} </span>
            )}
            {msg.body}
          </div>
        )}

        {reply && (
          <div
            style={{
              marginTop: 14,
              background: L.cardSoft,
              borderLeft: `3px solid ${L.accentText}`,
              borderRadius: '0 8px 8px 0',
              padding: '14px 18px',
              fontFamily: theme.fonts.sans,
              fontSize: 21,
              lineHeight: 1.42,
              color: L.ink,
            }}
          >
            {reply.body}
          </div>
        )}
      </div>
    </div>
  );
};

export const ChatThread: React.FC<{ beat: ChatBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const messages = beat.messages ?? [];
  const dxs = [0, 230, 110, 320, 60];
  const cardW = 1100;
  const hasHead = !!(beat.headline || beat.eyebrow);

  return (
    <ContentStage theme={theme} brandMark={brandMark} eyebrow={beat.eyebrow} title={beat.headline}>
      <div
        style={{
          position: 'absolute',
          left: theme.spacing.margin,
          top: hasHead ? 296 : 200,
          width: cardW + 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        {messages.map((m, i) => (
          <ChatCard key={i} msg={m} theme={theme} appear={10 + i * 16} dx={dxs[i % dxs.length]} width={cardW} />
        ))}
      </div>
    </ContentStage>
  );
};
