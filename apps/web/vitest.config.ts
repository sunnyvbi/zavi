import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

function workerCap(): { minWorkers?: number; maxWorkers?: number } {
  const raw = process.env.VITEST_MAX_WORKERS;
  let desired = 4;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `VITEST_MAX_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`,
      );
    }
    desired = parsed;
  }
  const cores = availableParallelism();
  return cores > desired ? { minWorkers: 1, maxWorkers: desired } : {};
}

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@zavi/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      'next/font/local': fileURLToPath(
        new URL('./src/fonts/nextFontLocal.vitest-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    deps: {
      optimizer: {
        web: {
          enabled: true,
          include: [
            'react',
            'react-dom',
            'react-dom/client',
            'lucide-react',
            '@testing-library/react',
            '@testing-library/dom',
          ],
        },
        ssr: {
          enabled: true,
          include: ['react', 'react-dom', 'react-dom/server', 'lucide-react'],
        },
      },
    },
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key',
    },
    setupFiles: ['./vitest.setup.ts'],
    environment: 'node',
    environmentMatchGlobs: [
      ['src/components/workspace/actions/managed-campaigns/CampaignScheduleStatus.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/ads/AdsActionFrame.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/ads/AdPreviewMedia.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/ads/LinkedInAdCardPreview.test.tsx', 'jsdom'],
      ['src/app/approvals/ApprovalsIsland.social.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/ChannelActionsLane.posts.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/PostCard.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/PostCard.draftLabel.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/history/ChannelHistory.posted.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/ActionFooter.rejectReason.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/ChannelDashboard.reconnect.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/ChannelDashboard.windowReadFailed.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/__tests__/copy-blanks-live-line.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/__tests__/top-actions-in-heading.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/AdsAccountSettings.heldElsewhere.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/AdsAccountSettings.launchFormKept.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/AdsAccountSettings.pending.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/AdsAccountSettings.review32.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/AdsAccountSettings.roleUnread.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/BoundAdsCampaigns.liveRole.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/BoundAdsCampaigns.lockAndPlace.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/BoundAdsCampaigns.relaunch.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/SponsoredPostReview.accountChoice.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/SponsoredPostReview.sheet.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/SponsoredPostReview.reconnect.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/SponsoredPostReview.tenantSwitch.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/SponsoredPostReview.postPicker.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/managed-campaigns/SponsoredPostReview.layout.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/topActions/__tests__/TopActionsRow.linkedinRole.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/useChannelActions.redoStale.test.tsx', 'jsdom'],
      ['src/components/workspace/layout/ChannelsPage.linkedinSafety.test.tsx', 'jsdom'],
      ['src/components/workspace/layout/__tests__/ChannelPanel.accountReread.test.tsx', 'jsdom'],
      ['src/components/workspace/layout/__tests__/ChannelTabs.dealValue.test.tsx', 'jsdom'],
      ['src/components/workspace/layout/__tests__/ChannelTabs.roleAndDraft.test.tsx', 'jsdom'],
      ['src/components/workspace/agent/reddit/{publish,redditPublishCoordinator,redditPublishStore}.test.ts', 'jsdom'],
      ['src/components/workspace/agent/reddit/useRedditPublish.test.tsx', 'jsdom'],
      ['src/components/workspace/navigation/*.test.tsx', 'jsdom'],
      ['src/components/workspace/layout/{ToolkitTab,ChatColumn}.test.tsx', 'jsdom'],
      ['src/components/workspace/layout/WorkspaceLayout.homeBuildPreviewLoop.test.tsx', 'jsdom'],
      ['src/components/workspace/Composer.homeChatSend.test.tsx', 'jsdom'],
      ['src/components/workspace/layout/ChannelActionChat.test.tsx', 'jsdom'],
      ['src/components/workspace/growth/*.test.tsx', 'jsdom'],
      ['src/components/marketing/growth-home/*.test.tsx', 'jsdom'],
      ['src/components/workspace/actions/useChannelActions.test.tsx', 'jsdom'],
      ['src/components/workspace/AutopilotTab.test.tsx', 'jsdom'],
      ['src/components/workspace/useAgentThreads.test.tsx', 'jsdom'],
      ['src/components/workspace/GrowthInterview.test.tsx', 'jsdom'],
      ['src/app/extension/connect/*.test.tsx', 'jsdom'],
      ['src/components/ui/ConfirmDialog.test.tsx', 'jsdom'],
    ],
    include: ['src/**/*.test.{ts,tsx}'],
    ...workerCap(),
  },
});
