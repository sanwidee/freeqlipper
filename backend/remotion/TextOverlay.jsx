import React from 'react';
import { AbsoluteFill } from 'remotion';

/**
 * TextOverlay Component - Renders text overlay with full CSS styling
 * This component is used by Remotion to generate a transparent PNG
 * that exactly matches the frontend preview.
 */
export const TextOverlay = ({
  text,
  textColor = '#00FF00',
  backgroundColor = 'transparent',
  bgEnabled = false,
  borderColor = '#000000',
  borderWidth = 8,
  fontFamily = 'Sans-Bold',
  fontSize = 72,
  alignment = 'center',
  verticalPosition = 75,
  width = 1080,
  height = 1920,
}) => {
  // Map font family to CSS font-family
  const fontFamilyMap = {
    'Sans-Bold': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'Poppins-Black': '"Poppins", sans-serif',
    'Arial-Bold': 'Arial, sans-serif',
    'Helvetica-Bold': 'Helvetica, sans-serif',
    'Impact': 'Impact, sans-serif',
    'Roboto-Bold': '"Roboto", sans-serif',
  };

  const cssFont = fontFamilyMap[fontFamily] || fontFamilyMap['Sans-Bold'];

  // Calculate text alignment
  const textAlign = alignment;
  const justifyContent = alignment === 'left' ? 'flex-start' : alignment === 'right' ? 'flex-end' : 'center';

  // Calculate vertical position (percentage from top)
  const top = `${verticalPosition}%`;

  // Build text shadow for outline effect (simulates FFmpeg borderw)
  const outlineShadows = [];
  if (!bgEnabled && borderWidth > 0) {
    const bw = borderWidth;
    // Create multiple shadows for thick outline effect
    for (let x = -bw; x <= bw; x++) {
      for (let y = -bw; y <= bw; y++) {
        if (x !== 0 || y !== 0) {
          outlineShadows.push(`${x}px ${y}px 0 ${borderColor}`);
        }
      }
    }
    // Add drop shadow for depth
    outlineShadows.push(`4px 4px 8px rgba(0,0,0,0.6)`);
  }

  const textShadow = outlineShadows.length > 0 ? outlineShadows.join(', ') : 'none';

  // Responsive font size based on container width
  const responsiveFontSize = Math.round((fontSize / 1080) * width);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: 'transparent',
        width,
        height,
      }}
    >
      {/* Text container positioned at vertical position */}
      <div
        style={{
          position: 'absolute',
          top,
          left: 0,
          right: 0,
          transform: 'translateY(-50%)',
          display: 'flex',
          justifyContent,
          padding: '0 40px',
        }}
      >
        <div
          style={{
            color: textColor,
            fontFamily: cssFont,
            fontSize: responsiveFontSize,
            fontWeight: 900,
            textAlign,
            lineHeight: 1.1,
            textShadow,
            // Background box styling
            backgroundColor: bgEnabled && backgroundColor !== 'transparent' ? backgroundColor : 'transparent',
            padding: bgEnabled ? '15px 30px' : '0',
            borderRadius: bgEnabled ? '12px' : '0',
            // Additional shadow for background boxes
            boxShadow: bgEnabled ? '4px 4px 12px rgba(0,0,0,0.4)' : 'none',
            // Max width to enable text wrapping
            maxWidth: '90%',
            wordWrap: 'break-word',
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default TextOverlay;
