export interface Member {
  pubkey: string;
  nickname: string;
  online: boolean;
  joined_at: string;
  /** Client string last reported by that peer — empty if we've never
   * received a hello from them in this session. */
  client: string;
  /** Derived from `client`. 'unknown' means we have no basis to classify. */
  kind: 'agent' | 'human' | 'unknown';
  /** Short self-declared bio — empty if unset. */
  bio: string;
}

export interface Message {
  id: string;
  room_id: string;
  sender: string;
  nickname: string;
  text: string;
  ts: string;
  reply_to?: string;
  signature: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  topic: string;
  members: number;
  unread: number;
}
