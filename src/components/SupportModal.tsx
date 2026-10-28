import React, { useState } from 'react';
import { Coffee, X, ExternalLink, ShieldCheck, Share2, Check, Sparkles, Server, Ban } from 'lucide-react';

interface SupportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SupportModal: React.FC<SupportModalProps> = ({ isOpen, onClose }) => {
  const [copiedLink, setCopiedLink] = useState(false);

  if (!isOpen) return null;

  const supportKoriUrl = 'https://www.supportkori.com/fardin12';

  const handleShare = async () => {
    const url = window.location.origin;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'EcO Smart Ledger',
          text: 'Check out EcO Smart Ledger — a clean, private, ad-free personal finance tracker.',
          url
        });
      } catch (err) {
        // User cancelled or share failed, fallback to copy
        copyToClipboard(url);
      }
    } else {
      copyToClipboard(url);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[#111317] border border-[#3D4943]/60 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Visual Warm Golden Coffee Header */}
        <div className="relative bg-gradient-to-br from-[#FFDD00] via-[#F59E0B] to-[#D97706] p-6 text-[#1A1C20] overflow-hidden select-none">
          {/* Subtle background decoration */}
          <div className="absolute -right-4 -bottom-4 w-32 h-32 rounded-full bg-white/10 blur-xl pointer-events-none" />
          <div className="absolute right-6 top-6 text-[#1A1C20]/20">
            <Coffee className="w-20 h-20" />
          </div>

          <div className="relative z-10 flex items-start justify-between">
            <div className="w-12 h-12 rounded-2xl bg-[#1A1C20] text-[#FFDD00] flex items-center justify-center shadow-md">
              <Coffee className="w-6 h-6 stroke-[2.2]" />
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full bg-black/10 hover:bg-black/20 text-[#1A1C20] transition-colors"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="relative z-10 mt-4">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-[#1A1C20]">
              Enjoying EcO? Buy me a coffee.
            </h2>
            <p className="text-xs text-[#1A1C20]/90 font-medium mt-1 leading-relaxed">
              Crafted with care by Fardin Hossain. 100% free, private, and ad-free forever.
            </p>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-4 text-xs">
          <p className="text-[#BCCAC1] leading-relaxed">
            EcO was created to make personal finance in Bangladesh simple, transparent, and private — with zero ads, zero subscriptions, and no invasive bank logins. If EcO has saved you time or helped manage your money, you can chip in to keep it thriving.
          </p>

          {/* 3 Pillars */}
          <div className="space-y-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#87948C]">
              Where your support goes
            </div>

            <div className="grid grid-cols-1 gap-2.5">
              <div className="p-3.5 rounded-xl bg-[#1A1C20] border border-[#3D4943]/40 flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#0C0E12] border border-[#73E3B4]/30 flex items-center justify-center text-[#73E3B4] shrink-0 mt-0.5">
                  <Server className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-semibold text-[#E2E2E8]">Keeping it online</div>
                  <p className="text-[11px] text-[#87948C] mt-0.5 leading-relaxed">
                    Helps cover fast cloud hosting, domain renewals, and reliable uptime so EcO is always ready when you need it.
                  </p>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[#1A1C20] border border-[#3D4943]/40 flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#0C0E12] border border-[#FFDD00]/30 flex items-center justify-center text-[#FFDD00] shrink-0 mt-0.5">
                  <Ban className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-semibold text-[#E2E2E8]">Staying free & ad-free</div>
                  <p className="text-[11px] text-[#87948C] mt-0.5 leading-relaxed">
                    Ensures EcO never has banner ads, tracking beacons, sponsored widgets, or gated premium tiers.
                  </p>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[#1A1C20] border border-[#3D4943]/40 flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#0C0E12] border border-[#73E3B4]/30 flex items-center justify-center text-[#73E3B4] shrink-0 mt-0.5">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-semibold text-[#E2E2E8]">Time to improve it</div>
                  <p className="text-[11px] text-[#87948C] mt-0.5 leading-relaxed">
                    Funds ongoing development for smart budgeting algorithms, export tools, offline syncing, and community feedback.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Security Reassurance Footnote */}
          <div className="p-3 rounded-xl bg-[#0C0E12] border border-[#3D4943]/30 flex items-center gap-2.5 text-[11px] text-[#87948C]">
            <ShieldCheck className="w-4 h-4 text-[#73E3B4] shrink-0" />
            <span>
              EcO never collects or stores banking details. Contributions happen directly and safely on SupportKori.
            </span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-5 border-t border-[#3D4943]/40 bg-[#1A1C20] space-y-3">
          {/* Primary Warm Yellow Support Button */}
          <a
            href={supportKoriUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full h-12 rounded-xl bg-[#FFDD00] hover:bg-[#FACC15] active:scale-[0.99] transition-all text-[#1A1C20] font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-[#FFDD00]/15"
          >
            <Coffee className="w-4 h-4 stroke-[2.5]" />
            <span>Support on SupportKori</span>
            <ExternalLink className="w-4 h-4" />
          </a>

          <div className="flex items-center justify-between gap-3 pt-1">
            <button
              onClick={handleShare}
              className="flex items-center gap-1.5 text-xs text-[#BCCAC1] hover:text-[#73E3B4] transition-colors py-1 cursor-pointer"
            >
              {copiedLink ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#73E3B4]" />
                  <span className="text-[#73E3B4] font-medium">Link copied!</span>
                </>
              ) : (
                <>
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Tell a friend about EcO</span>
                </>
              )}
            </button>

            <button
              onClick={onClose}
              className="text-xs text-[#87948C] hover:text-[#E2E2E8] py-1 cursor-pointer"
            >
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
