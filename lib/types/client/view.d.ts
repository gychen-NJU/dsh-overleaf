import type { ReactNode } from 'react';
import type { Translate } from './workbench.ts';
import type { EmbedInfo } from './wire.ts';
/** Message shape sent by the embedded bridge script. */
export interface BridgeMessage {
    ns?: string;
    type?: string;
}
export interface OutlineItem {
    level?: string | undefined;
    title?: string | undefined;
    line?: number | undefined;
    text?: string | undefined;
}
export interface OverleafViewProps {
    /** Provided by the standard conversation kit. */
    sessionId?: string | undefined;
    /** Slot locale translate helper. */
    t?: Translate | undefined;
    /** Feature switches resolved from embed-info. */
    features?: EmbedInfo | undefined;
    /** Standard-kit composer actions (submit the edited draft). */
    inputActions?: {
        submit(): unknown;
        setDraft(text: string): unknown;
    } | undefined;
}
/** OverleafView — registered under the conversation.view slot. */
export declare function OverleafView(props: OverleafViewProps): ReactNode;
