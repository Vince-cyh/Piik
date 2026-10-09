package protocol

import (
	"errors"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const MaxChatCodePoints = 280
const InteractionIntervalMs = 800

// Laser pointer updates run on their own, faster pace: a pointer that moved
// at chat speed would visibly stutter, while chat must stay calm.
const LaserIntervalMs = 60

// The shared board relays stroke ops on the same fast lane as the laser.
// Snapshot limits keep one message under MaxSignalBytes.
const PaintAppendPointLimit = 64
const PaintStrokePointLimit = 2000
const PaintSnapshotStrokeLimit = 200
const PaintSnapshotPointLimit = 8000
const PaintColorCount = 12

// PaintPoint is a normalized [x, y] pair within the shared picture.
type PaintPoint [2]float64

type PaintStroke struct {
	ID     string       `json:"id"`
	By     string       `json:"by"`
	Color  *int         `json:"color,omitempty"`
	Points []PaintPoint `json:"points"`
}

type InteractionPayload struct {
	Kind         string        `json:"kind"`
	Text         string        `json:"text,omitempty"`
	Reaction     string        `json:"reaction,omitempty"`
	TargetPeerID string        `json:"targetPeerId,omitempty"`
	X            *float64      `json:"x,omitempty"`
	Y            *float64      `json:"y,omitempty"`
	Phase        string        `json:"phase,omitempty"`
	Op           string        `json:"op,omitempty"`
	Space        string        `json:"space,omitempty"`
	StrokeID     string        `json:"strokeId,omitempty"`
	Point        *PaintPoint   `json:"point,omitempty"`
	Color        *int          `json:"color,omitempty"`
	Points       []PaintPoint  `json:"points,omitempty"`
	Strokes      []PaintStroke `json:"strokes,omitempty"`
}

func (payload *InteractionPayload) UnmarshalJSON(data []byte) error {
	type plain InteractionPayload
	var value plain
	fields, err := decodeObject(data, &value)
	if err != nil {
		return err
	}
	if err = fields.require("kind"); err != nil {
		return err
	}
	forbidsPaint := func() bool {
		return fields.has("op") || fields.has("space") || fields.has("strokeId") || fields.has("point") ||
			fields.has("points") || fields.has("strokes") || fields.has("color")
	}
	switch value.Kind {
	case "chat":
		if err = fields.require("text"); err != nil {
			return err
		}
		if fields.has("reaction") || fields.has("targetPeerId") ||
			fields.has("x") || fields.has("y") || fields.has("phase") || forbidsPaint() ||
			hasUnpairedSurrogateEscape(fields["text"]) || !validChatText(value.Text) {
			return errors.New("invalid chat payload")
		}
	case "reaction":
		if err = fields.require("reaction"); err != nil {
			return err
		}
		if err = fields.optional("targetPeerId"); err != nil {
			return err
		}
		if fields.has("text") || fields.has("x") || fields.has("y") || fields.has("phase") ||
			forbidsPaint() || (fields.has("targetPeerId") && !ValidOpaqueID(value.TargetPeerID)) {
			return errors.New("invalid reaction payload")
		}
		switch value.Reaction {
		case "tomato", "poop":
			if !ValidOpaqueID(value.TargetPeerID) {
				return errors.New("throwing a prop requires a participant")
			}
		case "wave", "heart", "clap", "laugh", "wow", "party", "fire", "eyes", "star", "sleep":
		default:
			return errors.New("unknown reaction")
		}
	case "laser":
		if err = fields.require("x", "y", "phase"); err != nil {
			return err
		}
		if fields.has("text") || fields.has("reaction") || fields.has("targetPeerId") || forbidsPaint() ||
			value.X == nil || value.Y == nil ||
			*value.X < 0 || *value.X > 1 || *value.Y < 0 || *value.Y > 1 {
			return errors.New("invalid laser payload")
		}
		switch value.Phase {
		case "down", "move", "up":
		default:
			return errors.New("unknown laser phase")
		}
	case "paint":
		if fields.has("text") || fields.has("reaction") || fields.has("targetPeerId") ||
			fields.has("x") || fields.has("y") || fields.has("phase") {
			return errors.New("invalid paint payload")
		}
		if err = validatePaintPayload(fields, (*InteractionPayload)(&value)); err != nil {
			return err
		}
	default:
		return errors.New("unknown interaction kind")
	}
	*payload = InteractionPayload(value)
	return nil
}

func validatePaintPayload(fields fields, value *InteractionPayload) error {
	if err := fields.require("space"); err != nil {
		return err
	}
	if value.Space != "stage" && value.Space != "panel" {
		return errors.New("unknown paint space")
	}
	strokeID, hasStrokeID := value.StrokeID, fields.has("strokeId")
	if hasStrokeID && !ValidOpaqueID(strokeID) {
		return errors.New("invalid paint strokeId")
	}
	if value.Color != nil && (*value.Color < 0 || *value.Color >= PaintColorCount) {
		return errors.New("invalid paint color")
	}
	switch value.Op {
	case "begin":
		if err := fields.require("strokeId", "point"); err != nil {
			return err
		}
		if fields.has("points") || fields.has("strokes") || !validPaintPoint(value.Point) {
			return errors.New("invalid paint begin payload")
		}
	case "append":
		if err := fields.require("strokeId", "points"); err != nil {
			return err
		}
		if fields.has("point") || fields.has("strokes") || fields.has("color") ||
			len(value.Points) < 1 || len(value.Points) > PaintAppendPointLimit {
			return errors.New("invalid paint append payload")
		}
		for _, point := range value.Points {
			if !validPaintPoint(&point) {
				return errors.New("invalid paint point")
			}
		}
	case "end", "undo":
		if err := fields.require("strokeId"); err != nil {
			return err
		}
		if fields.has("point") || fields.has("points") || fields.has("strokes") || fields.has("color") {
			return errors.New("invalid paint payload")
		}
	case "clear", "sync-request":
		if hasStrokeID || fields.has("point") || fields.has("points") || fields.has("strokes") || fields.has("color") {
			return errors.New("invalid paint payload")
		}
	case "snapshot":
		if err := fields.require("strokes"); err != nil {
			return err
		}
		if hasStrokeID || fields.has("point") || fields.has("points") || fields.has("color") ||
			len(value.Strokes) < 1 || len(value.Strokes) > PaintSnapshotStrokeLimit {
			return errors.New("invalid paint snapshot payload")
		}
		total := 0
		for _, stroke := range value.Strokes {
			if !ValidOpaqueID(stroke.ID) || !ValidOpaqueID(stroke.By) ||
				len(stroke.Points) < 1 || len(stroke.Points) > PaintStrokePointLimit {
				return errors.New("invalid paint snapshot stroke")
			}
			if stroke.Color != nil && (*stroke.Color < 0 || *stroke.Color >= PaintColorCount) {
				return errors.New("invalid paint stroke color")
			}
			total += len(stroke.Points)
			if total > PaintSnapshotPointLimit {
				return errors.New("paint snapshot exceeds point limit")
			}
			for _, point := range stroke.Points {
				if !validPaintPoint(&point) {
					return errors.New("invalid paint point")
				}
			}
		}
	default:
		return errors.New("unknown paint op")
	}
	return nil
}

func validPaintPoint(point *PaintPoint) bool {
	return point != nil && point[0] >= 0 && point[0] <= 1 && point[1] >= 0 && point[1] <= 1
}

func validChatText(value string) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) >= 1 &&
		utf8.RuneCountInString(value) <= MaxChatCodePoints && !forbiddenDisplayNameCharacters.MatchString(value) &&
		norm.NFC.IsNormalString(value) && strings.TrimFunc(value, IsJSWhitespace) == value
}

type SubscribeRoomInteractionsMessage struct {
	Type string `json:"type"`
}
type SendRoomInteractionMessage struct {
	Type      string             `json:"type"`
	RequestID string             `json:"requestId"`
	Payload   InteractionPayload `json:"payload"`
}

func (SubscribeRoomInteractionsMessage) isClientMessage() {}
func (SendRoomInteractionMessage) isClientMessage()       {}

func decodeSendRoomInteraction(data []byte) (ClientMessage, error) {
	var message SendRoomInteractionMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "requestId", "payload"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.RequestID) {
		return nil, errors.New("invalid interaction requestId")
	}
	return message, nil
}

type InteractionSender struct {
	PeerID      string      `json:"peerId"`
	Role        Role        `json:"role"`
	DisplayName DisplayName `json:"displayName"`
}

func (sender *InteractionSender) UnmarshalJSON(data []byte) error {
	type plain InteractionSender
	var value plain
	present, err := decodeObject(data, &value)
	if err != nil {
		return err
	}
	if err = present.require("peerId", "role", "displayName"); err != nil {
		return err
	}
	if !ValidOpaqueID(value.PeerID) {
		return errors.New("invalid sender peerId")
	}
	*sender = InteractionSender(value)
	return nil
}

type RoomInteractionsReadyMessage struct {
	Type       string `json:"type"`
	ServerTime Int    `json:"serverTime"`
}
type RoomInteractionMessage struct {
	Type       string             `json:"type"`
	ID         string             `json:"id"`
	RequestID  string             `json:"requestId"`
	OccurredAt Int                `json:"occurredAt"`
	Sender     InteractionSender  `json:"sender"`
	Payload    InteractionPayload `json:"payload"`
}
type RoomInteractionRejectedMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Reason    string `json:"reason"`
}

func (RoomInteractionsReadyMessage) isServerMessage()   {}
func (RoomInteractionMessage) isServerMessage()         {}
func (RoomInteractionRejectedMessage) isServerMessage() {}

func decodeRoomInteractionsReady(data []byte) (ServerMessage, error) {
	var message RoomInteractionsReadyMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "serverTime"); err != nil {
		return nil, err
	}
	if !inRangeInt(message.ServerTime, 0, MaxSafeInteger) {
		return nil, errors.New("invalid interaction server time")
	}
	return message, nil
}

func decodeRoomInteraction(data []byte) (ServerMessage, error) {
	var message RoomInteractionMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "id", "requestId", "occurredAt", "sender", "payload"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ID) || !ValidOpaqueID(message.RequestID) {
		return nil, errors.New("invalid interaction identity")
	}
	if !inRangeInt(message.OccurredAt, 0, MaxSafeInteger) {
		return nil, errors.New("invalid interaction time")
	}
	return message, nil
}
func decodeRoomInteractionRejected(data []byte) (ServerMessage, error) {
	var message RoomInteractionRejectedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "requestId", "reason"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.RequestID) {
		return nil, errors.New("invalid interaction requestId")
	}
	switch message.Reason {
	case "rate-limited", "target-unavailable", "not-subscribed", "busy":
	default:
		return nil, errors.New("invalid rejection reason")
	}
	return message, nil
}
