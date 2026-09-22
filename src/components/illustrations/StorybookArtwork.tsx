import React from "react";
import catOnBooksImg from "../../assets/images/cat_on_books_master_1789382694223.webp";
import pagodaHeaderImg from "../../assets/images/pagoda_header_master_1789382709603.webp";
import storyVignetteImg from "../../assets/images/storybook_vignette_1789376893491.webp";

/**
 * Storybook Artwork & Vector Illustrations
 * Uses high-fidelity storybook illustration assets matching the master reference image.
 */

export const SakuraBlossom: React.FC<{ className?: string; size?: number }> = ({
  className = "",
  size = 20,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`inline-block ${className}`}
  >
    {/* 5 Petals of Sakura */}
    <g transform="translate(24, 24)">
      {[0, 72, 144, 216, 288].map((angle, i) => (
        <path
          key={i}
          d="M 0 0 C -6 -11, -11 -20, -6 -23 C -2 -25, 0 -22, 0 -20 C 0 -22, 2 -25, 6 -23 C 11 -20, 6 -11, 0 0 Z"
          fill="url(#sakuraPetalGrad)"
          stroke="#F472B6"
          strokeWidth="0.8"
          transform={`rotate(${angle})`}
          opacity="0.95"
        />
      ))}
      {/* Pistils / Center */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
        <line
          key={i}
          x1="0"
          y1="0"
          x2="0"
          y2="-6"
          stroke="#EC4899"
          strokeWidth="1"
          strokeLinecap="round"
          transform={`rotate(${angle})`}
        />
      ))}
      <circle cx="0" cy="0" r="3" fill="#F43F5E" />
      <circle cx="0" cy="0" r="1.5" fill="#FEF08A" />
    </g>
    <defs>
      <linearGradient id="sakuraPetalGrad" x1="0%" y1="100%" x2="0%" y2="0%">
        <stop offset="0%" stopColor="#FBCFE8" />
        <stop offset="60%" stopColor="#F9A8D4" />
        <stop offset="100%" stopColor="#F472B6" />
      </linearGradient>
    </defs>
  </svg>
);

export const SparkleStar: React.FC<{ className?: string; size?: number }> = ({
  className = "",
  size = 16,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
    className={`inline-block ${className}`}
  >
    <path d="M12 0C12 6.627 6.627 12 0 12C6.627 12 12 17.373 12 24C12 17.373 17.373 12 24 12C17.373 12 12 6.627 12 0Z" />
  </svg>
);

/**
 * Pagoda Landscape Banner (Header Backdrop)
 * Illustrated watercolor Chinese/Japanese pagoda on rolling misty hills with blooming sakura branches
 * Optimized specifically for 360-430px mobile viewports so pagoda and sakura are clearly visible behind the navbar
 */
export const PagodaHeaderIllustration: React.FC<{ className?: string }> = ({ className = "" }) => {
  return (
    <div className={`pointer-events-none absolute inset-x-0 top-0 h-64 sm:h-72 overflow-hidden select-none z-0 ${className}`}>
      <img
        src={pagodaHeaderImg}
        alt="Pagoda Header Landscape"
        className="w-full h-full object-cover object-top opacity-95"
      />
      {/* Soft gradient transition into page content */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#FAF8FE] via-[#FAF8FE]/80 to-transparent dark:from-slate-950 dark:via-slate-950/80" />
    </div>
  );
};

/**
 * The Sleeping Cat on Books Artwork
 * Directly reproduces the cute illustrated character art shown on Screen 2 of the reference image:
 * A cozy white/cream kitten curled up asleep on a stack of storybooks, with sakura flowers, floating petals, and sparkles!
 */
/**
 * The Sleeping Cat on Books Artwork
 * Directly reproduces the exact cute storybook illustration shown on Screen 2 of the reference image:
 * A cozy white sleeping kitten curled up on a stack of 3 plain pastel books (pink, purple, blue) with gold star accents,
 * surrounded by sakura blossoms, floating petals, and soft misty mountain silhouettes.
 * 100% transparent background, ZERO box frames, ZERO text on book spines!
 */
export const SleepingCatIllustration: React.FC<{ className?: string }> = ({
  className = "",
}) => {
  return (
    <div className={`relative flex flex-col items-center justify-center select-none w-full py-2 ${className}`}>
      <div className="relative w-full max-w-[320px] aspect-[4/3] flex items-center justify-center">
        <svg
          viewBox="0 0 400 320"
          className="w-full h-full drop-shadow-sm"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            {/* Soft background mountain gradient */}
            <linearGradient id="catMountainGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#E0F2FE" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#F0F9FF" stopOpacity="0" />
            </linearGradient>

            {/* Book 1 (Top Pink) Gradient */}
            <linearGradient id="bookPinkGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#F472B6" />
              <stop offset="15%" stopColor="#FBCFE8" />
              <stop offset="85%" stopColor="#FCE7F3" />
              <stop offset="100%" stopColor="#F472B6" />
            </linearGradient>

            {/* Book 2 (Middle Purple) Gradient */}
            <linearGradient id="bookPurpleGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#A855F7" />
              <stop offset="15%" stopColor="#E9D5FF" />
              <stop offset="85%" stopColor="#F3E8FF" />
              <stop offset="100%" stopColor="#C084FC" />
            </linearGradient>

            {/* Book 3 (Bottom Blue) Gradient */}
            <linearGradient id="bookBlueGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#0284C7" />
              <stop offset="15%" stopColor="#BAE6FD" />
              <stop offset="85%" stopColor="#E0F2FE" />
              <stop offset="100%" stopColor="#38BDF8" />
            </linearGradient>

            {/* Fur Shading Gradient */}
            <linearGradient id="catFurGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="70%" stopColor="#FFFDF9" />
              <stop offset="100%" stopColor="#FCE7F3" />
            </linearGradient>

            {/* Gold Star Charm Accent */}
            <linearGradient id="goldCharm" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FBBF24" />
              <stop offset="100%" stopColor="#F59E0B" />
            </linearGradient>
          </defs>

          {/* 1. Background Soft Misty Mountains */}
          <path
            d="M 40 220 Q 110 140 190 170 Q 270 110 360 220 Z"
            fill="url(#catMountainGrad)"
          />
          <path
            d="M 10 230 Q 90 170 160 190 Q 250 150 390 230 Z"
            fill="#F0F9FF"
            opacity="0.5"
          />

          {/* 2. Floating Petals & Sparkles in Background */}
          {/* Sparkle 1 */}
          <path d="M 70 90 C 70 95 65 100 60 100 C 65 100 70 105 70 110 C 70 105 75 100 80 100 C 75 100 70 95 70 90 Z" fill="#FBBF24" opacity="0.8" />
          <path d="M 320 80 C 320 84 316 88 312 88 C 316 88 320 92 320 96 C 320 92 324 88 328 88 C 324 88 320 84 320 80 Z" fill="#FBBF24" opacity="0.8" />
          <path d="M 340 160 C 340 163 337 166 334 166 C 337 166 340 169 340 172 C 340 169 343 166 346 166 C 343 166 340 163 340 160 Z" fill="#FBBF24" opacity="0.7" />

          {/* Drifting Petals */}
          <ellipse cx="65" cy="140" rx="7" ry="3.5" fill="#FBCFE8" transform="rotate(-25 65 140)" />
          <ellipse cx="330" cy="120" rx="8" ry="4" fill="#F9A8D4" transform="rotate(20 330 120)" />
          <ellipse cx="90" cy="70" rx="6" ry="3" fill="#F472B6" transform="rotate(35 90 70)" />
          <ellipse cx="310" cy="180" rx="7" ry="3.5" fill="#FBCFE8" transform="rotate(-15 310 180)" />

          {/* 3. BOOK STACK (Bottom to Top) */}

          {/* --- BOOK 3: BOTTOM BLUE BOOK --- */}
          {/* Pages block */}
          <path d="M 105 240 L 305 240 L 315 258 L 115 258 Z" fill="#FFFDF5" stroke="#E2E8F0" strokeWidth="1" />
          {/* Cover Spine & Edge */}
          <path d="M 90 240 C 90 235 95 235 105 235 L 315 235 C 322 235 325 240 325 243 L 320 263 C 320 266 313 266 305 266 L 95 266 C 85 266 82 258 82 250 C 82 243 85 240 90 240 Z" fill="url(#bookBlueGrad)" stroke="#0284C7" strokeWidth="1.5" />
          {/* Spine Gold Star Decoration */}
          <path d="M 100 250 L 102 245 L 107 245 L 103 248 L 105 253 L 100 250 Z" fill="url(#goldCharm)" />

          {/* --- BOOK 2: MIDDLE PURPLE BOOK --- */}
          {/* Pages block */}
          <path d="M 115 210 L 295 210 L 305 228 L 125 228 Z" fill="#FFFDF5" stroke="#E2E8F0" strokeWidth="1" />
          {/* Cover Spine & Edge */}
          <path d="M 100 210 C 100 205 105 205 115 205 L 305 205 C 312 205 315 210 315 213 L 310 233 C 310 236 303 236 295 236 L 105 236 C 95 236 92 228 92 220 C 92 213 95 210 100 210 Z" fill="url(#bookPurpleGrad)" stroke="#7C3AED" strokeWidth="1.5" />
          {/* Ribbon Bookmark hanging down */}
          <path d="M 270 205 Q 275 240 280 265 L 286 262 L 288 268 L 275 269 Z" fill="#EC4899" opacity="0.9" />
          <circle cx="280" cy="272" r="3" fill="url(#goldCharm)" />

          {/* --- BOOK 1: TOP PINK BOOK --- */}
          {/* Pages block */}
          <path d="M 125 180 L 285 180 L 293 198 L 133 198 Z" fill="#FFFDF5" stroke="#CBD5E1" strokeWidth="1" />
          {/* Cover Spine & Edge */}
          <path d="M 110 180 C 110 175 115 175 125 175 L 293 175 C 300 175 303 180 303 183 L 298 203 C 298 206 291 206 283 206 L 115 206 C 105 206 102 198 102 190 C 102 183 105 180 110 180 Z" fill="url(#bookPinkGrad)" stroke="#DB2777" strokeWidth="1.5" />
          {/* Ribbon Bookmark hanging down */}
          <path d="M 140 180 Q 138 215 135 240 L 140 238 L 142 244 L 132 245 Z" fill="#F59E0B" />

          {/* 4. COZY WHITE SLEEPING KITTEN */}
          {/* Kitten Tail */}
          <path
            d="M 275 178 C 305 180 320 200 310 220 C 305 225 295 220 298 212 C 305 200 295 188 270 186 Z"
            fill="url(#catFurGrad)"
            stroke="#F472B6"
            strokeWidth="1"
          />

          {/* Kitten Body (Curled sleeping oval) */}
          <ellipse
            cx="210"
            cy="165"
            rx="65"
            ry="30"
            fill="url(#catFurGrad)"
            stroke="#F472B6"
            strokeWidth="1.2"
          />
          {/* Soft back hip curve */}
          <path
            d="M 235 142 C 265 145 275 160 265 175"
            stroke="#F472B6"
            strokeWidth="1"
            strokeLinecap="round"
            fill="none"
            opacity="0.6"
          />

          {/* Kitten Head */}
          <circle
            cx="160"
            cy="155"
            r="32"
            fill="url(#catFurGrad)"
            stroke="#F472B6"
            strokeWidth="1.2"
          />

          {/* Left Ear */}
          <path
            d="M 135 136 C 130 115 145 118 152 130 Z"
            fill="url(#catFurGrad)"
            stroke="#F472B6"
            strokeWidth="1.2"
          />
          <path
            d="M 138 133 C 134 120 144 122 148 130 Z"
            fill="#FBCFE8"
          />

          {/* Right Ear */}
          <path
            d="M 165 128 C 172 110 186 118 178 134 Z"
            fill="url(#catFurGrad)"
            stroke="#F472B6"
            strokeWidth="1.2"
          />
          <path
            d="M 168 128 C 173 115 182 120 176 132 Z"
            fill="#FBCFE8"
          />

          {/* Sleeping Closed Eyes (Sweet gentle arcs `^ ^`) */}
          <path
            d="M 144 158 Q 149 163 154 158"
            stroke="#9D4EDD"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 162 158 Q 167 163 172 158"
            stroke="#9D4EDD"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />

          {/* Tiny Nose & Mouth */}
          <path d="M 157 163 L 159 165 L 157 166 Z" fill="#F472B6" />
          <path d="M 155 167 Q 157 169 159 167" stroke="#F472B6" strokeWidth="1" strokeLinecap="round" fill="none" />

          {/* Blushing Cheeks */}
          <ellipse cx="142" cy="163" rx="5" ry="3" fill="#F472B6" opacity="0.45" />
          <ellipse cx="174" cy="163" rx="5" ry="3" fill="#F472B6" opacity="0.45" />

          {/* Paws tucked under chin */}
          <ellipse cx="150" cy="182" rx="10" ry="6" fill="url(#catFurGrad)" stroke="#F472B6" strokeWidth="1" />
          <ellipse cx="165" cy="182" rx="9" ry="5.5" fill="url(#catFurGrad)" stroke="#F472B6" strokeWidth="1" />

          {/* 5. FOREGROUND SAKURA BRANCHES & FLOWERS */}

          {/* Left Branch Blooming Flowers */}
          <g transform="translate(75, 190)">
            <path d="M -15 20 Q 0 0 20 -10" stroke="#78350F" strokeWidth="2.5" strokeLinecap="round" />
            {/* Flower 1 */}
            <circle cx="-12" cy="15" r="7" fill="#FBCFE8" stroke="#F472B6" strokeWidth="0.8" />
            <circle cx="-12" cy="15" r="2.5" fill="#F43F5E" />
            {/* Flower 2 */}
            <circle cx="10" cy="-5" r="8.5" fill="#FBCFE8" stroke="#F472B6" strokeWidth="0.8" />
            <circle cx="10" cy="-5" r="3" fill="#F43F5E" />
          </g>

          {/* Right Branch Blooming Flowers */}
          <g transform="translate(325, 210)">
            <path d="M 15 20 Q 0 0 -15 -10" stroke="#78350F" strokeWidth="2.5" strokeLinecap="round" />
            {/* Flower 1 */}
            <circle cx="12" cy="15" r="7.5" fill="#FBCFE8" stroke="#F472B6" strokeWidth="0.8" />
            <circle cx="12" cy="15" r="2.5" fill="#F43F5E" />
            {/* Flower 2 */}
            <circle cx="-8" cy="-5" r="9" fill="#FBCFE8" stroke="#F472B6" strokeWidth="0.8" />
            <circle cx="-8" cy="-5" r="3" fill="#F43F5E" />
          </g>

          {/* Petals resting on books */}
          <ellipse cx="120" cy="177" rx="4" ry="2" fill="#F472B6" transform="rotate(10 120 177)" />
          <ellipse cx="290" cy="204" rx="4.5" ry="2.2" fill="#F9A8D4" transform="rotate(-20 290 204)" />
        </svg>
      </div>
    </div>
  );
};

/**
 * Storybook Vignette for Translation Complete State (Screen 3)
 * Traditional Chinese pagoda with soft watercolor mountains, blooming sakura branches,
 * and the charming hand-lettered quote: "Good stories travel far ♥"
 */
export const StoryVignetteIllustration: React.FC<{ className?: string }> = ({
  className = "",
}) => {
  return (
    <div className={`relative flex flex-col items-center justify-center p-2 select-none ${className}`}>
      <div className="relative w-full max-w-[300px] overflow-hidden rounded-2xl">
        <img
          src={storyVignetteImg}
          alt="Story Vignette"
          className="w-full h-auto object-cover rounded-2xl mix-blend-multiply dark:mix-blend-normal"
        />
      </div>
      <div className="mt-2 text-center">
        <p className="font-serif italic text-lg font-bold text-purple-700 dark:text-purple-300 tracking-wide">
          Good stories travel far ♥
        </p>
      </div>
    </div>
  );
};

/**
 * Bottom Sakura Footer Branch Decoration
 * Delicately frames the bottom above and behind the navigation bar
 */
export const SakuraFooterDecoration: React.FC = () => {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-14 h-16 overflow-hidden select-none -z-10">
      <svg
        className="w-full h-full object-cover"
        viewBox="0 0 400 60"
        preserveAspectRatio="xMidYMax slice"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Soft petals drifting along bottom */}
        <g opacity="0.75">
          <ellipse cx="40" cy="45" rx="5" ry="2.5" fill="#FBCFE8" transform="rotate(15 40 45)" />
          <ellipse cx="90" cy="30" rx="4" ry="2" fill="#F472B6" transform="rotate(-25 90 30)" />
          <ellipse cx="160" cy="40" rx="5.5" ry="2.8" fill="#F9A8D4" transform="rotate(35 160 40)" />
          <ellipse cx="230" cy="25" rx="4.5" ry="2.2" fill="#FBCFE8" transform="rotate(-15 230 25)" />
          <ellipse cx="310" cy="42" rx="5" ry="2.5" fill="#F472B6" transform="rotate(20 310 42)" />
          <ellipse cx="370" cy="35" rx="4" ry="2" fill="#FBCFE8" transform="rotate(-30 370 35)" />
        </g>
      </svg>
    </div>
  );
};
