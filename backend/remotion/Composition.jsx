import React from 'react';
import { Composition } from 'remotion';
import { TextOverlay } from './TextOverlay';

/**
 * Remotion Root Component
 * Defines the composition for rendering text overlays
 */
export const RemotionRoot = () => {
  return (
    <>
      {/* 9:16 Portrait (1080x1920) */}
      <Composition
        id="TextOverlay-9-16"
        component={TextOverlay}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          text: 'Hook Text',
          textColor: '#00FF00',
          backgroundColor: 'transparent',
          bgEnabled: false,
          borderColor: '#000000',
          borderWidth: 8,
          fontFamily: 'Sans-Bold',
          fontSize: 72,
          alignment: 'center',
          verticalPosition: 75,
          width: 1080,
          height: 1920,
        }}
      />
      
      {/* 1:1 Square (1080x1080) */}
      <Composition
        id="TextOverlay-1-1"
        component={TextOverlay}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          text: 'Hook Text',
          textColor: '#00FF00',
          backgroundColor: 'transparent',
          bgEnabled: false,
          borderColor: '#000000',
          borderWidth: 8,
          fontFamily: 'Sans-Bold',
          fontSize: 72,
          alignment: 'center',
          verticalPosition: 75,
          width: 1080,
          height: 1080,
        }}
      />
      
      {/* 16:9 Landscape (1920x1080) */}
      <Composition
        id="TextOverlay-16-9"
        component={TextOverlay}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          text: 'Hook Text',
          textColor: '#00FF00',
          backgroundColor: 'transparent',
          bgEnabled: false,
          borderColor: '#000000',
          borderWidth: 8,
          fontFamily: 'Sans-Bold',
          fontSize: 72,
          alignment: 'center',
          verticalPosition: 75,
          width: 1920,
          height: 1080,
        }}
      />
      
      {/* 3:4 Instagram Post (1080x1440) */}
      <Composition
        id="TextOverlay-3-4"
        component={TextOverlay}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1440}
        defaultProps={{
          text: 'Hook Text',
          textColor: '#00FF00',
          backgroundColor: 'transparent',
          bgEnabled: false,
          borderColor: '#000000',
          borderWidth: 8,
          fontFamily: 'Sans-Bold',
          fontSize: 72,
          alignment: 'center',
          verticalPosition: 75,
          width: 1080,
          height: 1440,
        }}
      />
    </>
  );
};
