const POSTHOG_DEFAULTS_DATE = "2026-01-30";
const POSTHOG_DEFAULT_API_HOST = "https://us.i.posthog.com";
const POSTHOG_APP_SURFACE = "voice-agent";

export type PostHogBrowserConfig = {
  apiKey: string;
  apiHost: string;
  defaults: string;
  appSurface: string;
  enableSessionReplay: boolean;
  captureTranscripts: boolean;
};

export type PostHogCaptureEvent = {
  apiKey: string;
  apiHost?: string;
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
};

export function getPostHogAppSurface(): string {
  return POSTHOG_APP_SURFACE;
}

export function normalizePostHogApiHost(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return POSTHOG_DEFAULT_API_HOST;
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function parseBooleanEnv(value: string | undefined, defaultValue = false): boolean {
  if (typeof value !== "string") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function buildPostHogBrowserConfig(env: {
  POSTHOG_PROJECT_API_KEY?: string;
  POSTHOG_API_HOST?: string;
  POSTHOG_ENABLE_SESSION_REPLAY?: string;
  POSTHOG_CAPTURE_TRANSCRIPTS?: string;
}): PostHogBrowserConfig | null {
  const apiKey = env.POSTHOG_PROJECT_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    apiHost: normalizePostHogApiHost(env.POSTHOG_API_HOST),
    defaults: POSTHOG_DEFAULTS_DATE,
    appSurface: POSTHOG_APP_SURFACE,
    enableSessionReplay: parseBooleanEnv(env.POSTHOG_ENABLE_SESSION_REPLAY, false),
    captureTranscripts: parseBooleanEnv(env.POSTHOG_CAPTURE_TRANSCRIPTS, true),
  };
}

export function buildPostHogBrowserBootstrapScript(config: PostHogBrowserConfig): string {
  const postHogSnippet =
    "!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.crossOrigin='anonymous',p.async=!0,p.src=s.api_host.replace('.i.posthog.com','-assets.i.posthog.com')+'/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],u.toString=function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e},u.people.toString=function(){return u.toString(1)+'.people (stub)'},o='init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);";
  const initOptions = [
    `api_host:${JSON.stringify(config.apiHost)}`,
    `defaults:${JSON.stringify(config.defaults)}`,
    "capture_pageview:false",
    "capture_pageleave:false",
    "autocapture:false",
    `disable_session_recording:${config.enableSessionReplay ? "false" : "true"}`,
    "bootstrap:{distinctID:distinctId}",
  ];
  if (config.enableSessionReplay) {
    initOptions.push("session_recording:{maskAllInputs:true,maskTextSelector:'*'}");
  }

  return `<script>window.__POSTHOG_CONFIG__=${JSON.stringify(config)};(function(){var host=window.location&&window.location.host||'';var isLocal=host.includes('localhost')||host.includes('127.0.0.1');var distinctId=null;try{distinctId=window.localStorage.getItem('voice_agent_posthog_distinct_id');if(!distinctId&&window.crypto&&typeof window.crypto.randomUUID==='function'){distinctId='voice-agent-'+window.crypto.randomUUID();window.localStorage.setItem('voice_agent_posthog_distinct_id',distinctId)}}catch(_error){}window.__VOICE_AGENT_POSTHOG_DISTINCT_ID__=distinctId;if(isLocal){return;}${postHogSnippet}posthog.init(${JSON.stringify(config.apiKey)},{${initOptions.join(",")}});})();</script>`;
}

export async function capturePostHogEvent(input: PostHogCaptureEvent): Promise<void> {
  const response = await fetch(`${normalizePostHogApiHost(input.apiHost)}/i/v0/e/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      api_key: input.apiKey,
      event: input.event,
      distinct_id: input.distinctId,
      properties: {
        app_surface: POSTHOG_APP_SURFACE,
        ...(input.properties ?? {}),
      },
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`PostHog capture failed with status ${response.status}`);
  }
}
