import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { interpolate, isPlausibleBirthDate, zhTW } from '@dongfan/shared';
import type { InviteDto, MemberDto } from '@dongfan/shared';
import { ErrorLine } from '../components/FieldErrors.js';
import { JoinBaby } from '../components/JoinBaby.js';
import { useSession } from '../lib/session.js';
import { useStore } from '../lib/store.js';

/**
 * Everything about the family rather than about the records (spec 7.8).
 *
 * The baby's own details, the one-time code that lets the other parent in,
 * who is already in, a way out, and signing out.
 */
export function Settings(): React.JSX.Element {
  const { baby } = useStore();
  const { me, signOut } = useSession();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center border-b border-line-soft px-2 py-2">
        <Link to="/" aria-label={zhTW.a11y.back} className="flex size-11 items-center justify-center text-ink-muted">
          <ChevronLeft size={22} />
        </Link>
        <span className="-ml-11 flex-1 text-center text-base font-medium">{zhTW.settings.title}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4 pb-10">
        <BabyDetails />
        <Invite />
        <Members me={me?.user.id ?? ''} />
        <Section title={zhTW.settings.joinSection}>
          <JoinBaby />
        </Section>

        <button
          type="button"
          onClick={signOut}
          data-testid="sign-out"
          className="mt-2 min-h-11 w-full rounded-xl border border-line text-sm text-red-300"
        >
          {zhTW.auth.signOut}
        </button>

        <p className="mt-6 text-center text-[11px] text-ink-dim">{baby.id}</p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 text-xs font-medium tracking-widest text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}

function BabyDetails(): React.JSX.Element {
  const { baby, editBaby } = useStore();
  const owner = baby.role === 'owner';

  const [nickname, setNickname] = useState(baby.nickname);
  const [gender, setGender] = useState(baby.gender);
  const [birthDate, setBirthDate] = useState(baby.birthDate);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const changed =
    nickname.trim() !== baby.nickname || gender !== baby.gender || birthDate !== baby.birthDate;

  const save = async (): Promise<void> => {
    setFailure(null);
    setSaved(false);

    if (nickname.trim() === '') {
      setFailure(zhTW.fieldError.REQUIRED);
      return;
    }
    // Checked here as well as on the server: the date control hands over
    // days that do not exist, and a round trip is a poor way to be told.
    if (!isPlausibleBirthDate(birthDate, Date.now(), baby.timezone)) {
      setFailure(zhTW.fieldError.INVALID_FORMAT);
      return;
    }

    setBusy(true);
    try {
      await editBaby({ nickname: nickname.trim(), gender, birthDate });
      setSaved(true);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={zhTW.settings.babySection}>
      <fieldset disabled={!owner || busy} className="contents">
        <label className="mb-3 flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.baby.nickname}</span>
          <input
            name="nickname"
            value={nickname}
            onChange={(e) => { setNickname(e.target.value); setSaved(false); }}
            className="rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint disabled:opacity-60"
          />
        </label>

        <div className="mb-3 flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.baby.gender}</span>
          <div className="flex gap-2">
            {(['male', 'female', 'other'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => { setGender(option); setSaved(false); }}
                aria-pressed={gender === option}
                className="min-h-11 flex-1 rounded-xl border py-3 text-sm disabled:opacity-60"
                style={
                  gender === option
                    ? { borderColor: '#E8B15C', borderWidth: 1.5, backgroundColor: '#E8B15C22', color: '#E8B15C' }
                    : { borderColor: '#2E2921', backgroundColor: '#1C1915', color: '#C9C0B2' }
                }
              >
                {zhTW.baby[option]}
              </button>
            ))}
          </div>
        </div>

        <label className="mb-3 flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.baby.birthDate}</span>
          <input
            type="date"
            aria-label={zhTW.baby.birthDate}
            value={birthDate}
            onChange={(e) => { setBirthDate(e.target.value); setSaved(false); }}
            className="min-h-12 rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint disabled:opacity-60"
          />
        </label>
      </fieldset>

      {owner ? null : (
        <p className="text-[11px] text-ink-dim" data-testid="owner-only">{zhTW.settings.ownerOnly}</p>
      )}

      <ErrorLine failure={failure} />

      {owner ? (
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !changed}
          data-testid="save-baby"
          className="min-h-11 w-full rounded-xl bg-accent text-sm font-bold text-ground disabled:opacity-50"
        >
          {saved && !changed ? zhTW.settings.saved : zhTW.settings.save}
        </button>
      ) : null}
    </Section>
  );
}

function Invite(): React.JSX.Element | null {
  const { baby, createInvite, now } = useStore();
  const [invite, setInvite] = useState<InviteDto | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);

  // Only the owner may make one, so only the owner is offered one
  // (spec 6.4). The server refuses either way.
  if (baby.role !== 'owner') return null;

  const generate = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setCopied(null);
    try {
      setInvite(await createInvite());
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const left = invite === null ? 0 : Math.ceil((invite.expiresAt - now) / 60_000);

  return (
    <Section title={zhTW.settings.inviteSection}>
      <p className="mb-3 text-[11px] leading-relaxed text-ink-dim">{zhTW.settings.inviteHint}</p>

      {invite ? (
        <div className="mb-3 rounded-xl border border-accent/40 bg-accent/10 p-3.5" data-testid="invite">
          <p
            data-testid="invite-code"
            className="font-numeric text-[15px] leading-relaxed tracking-wider break-all text-accent"
          >
            {invite.code}
          </p>
          <p className="mt-1.5 text-[11px] text-ink-muted">
            {left > 0
              ? interpolate(zhTW.settings.inviteExpires, { minutes: left })
              : zhTW.settings.inviteExpired}
          </p>
          <p className="mt-1 text-[11px] text-ink-dim">{zhTW.settings.inviteOnce}</p>
          <button
            type="button"
            data-testid="copy-invite"
            onClick={() => {
              // A clipboard needs a secure context and a permission, and
              // has neither on a LAN address over plain HTTP -- which is
              // where this is being tested. Saying "copied" when nothing
              // was copied sends somebody to paste an empty message.
              const clipboard = navigator.clipboard as Clipboard | undefined;
              if (!clipboard) {
                setCopied('no');
                return;
              }
              void clipboard
                .writeText(invite.code)
                .then(() => setCopied('yes'))
                .catch(() => setCopied('no'));
            }}
            className="mt-2 min-h-11 text-[12px] text-ink-dim"
          >
            {copied === 'yes' ? zhTW.settings.copied : zhTW.settings.copy}
          </button>
          {copied === 'no' ? (
            <p className="text-[11px] leading-relaxed text-warn-soft" data-testid="copy-failed">
              {zhTW.settings.copyFailed}
            </p>
          ) : null}
        </div>
      ) : null}

      <ErrorLine failure={failure} />

      <button
        type="button"
        onClick={() => void generate()}
        disabled={busy}
        data-testid="generate-invite"
        className="min-h-11 w-full rounded-xl border border-line text-sm text-ink-muted disabled:opacity-60"
      >
        {busy ? zhTW.settings.generating : zhTW.settings.generate}
      </button>
    </Section>
  );
}

function Members({ me }: { me: string }): React.JSX.Element {
  const { baby, listMembers, removeMember } = useStore();
  const navigate = useNavigate();

  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<MemberDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listMembers()
      .then((found) => { if (!cancelled) setMembers(found); })
      .catch((error: unknown) => { if (!cancelled) setFailure(error); });
    return () => { cancelled = true; };
  }, [listMembers]);

  const owners = (members ?? []).filter((member) => member.role === 'owner').length;

  const remove = async (member: MemberDto): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await removeMember(member.userId);
      // Leaving takes this baby away, and with it this screen. Where the
      // app goes next is the account's business, so back to the top.
      if (member.userId === me) navigate('/');
      else setMembers(await listMembers());
      setConfirming(null);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={zhTW.settings.membersSection}>
      {members === null ? (
        <p className="text-sm text-ink-dim">{zhTW.app.loading}</p>
      ) : (
        <ul className="mb-2 flex flex-col gap-1.5" data-testid="members">
          {members.map((member) => {
            const self = member.userId === me;
            // The last owner stays: a baby with nobody in charge can never
            // be invited to again and its details can never be corrected.
            const lastOwner = member.role === 'owner' && owners === 1;
            const mayRemove = (self || baby.role === 'owner') && !lastOwner;

            return (
              <li
                key={member.userId}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5"
                data-testid={`member-${member.username}`}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-[15px]">{member.username}</span>
                  <span className="ml-2 text-[11px] text-ink-dim">
                    {member.role === 'owner' ? zhTW.settings.roleOwner : zhTW.settings.roleMember}
                  </span>
                </div>
                {mayRemove ? (
                  <button
                    type="button"
                    onClick={() => setConfirming(member)}
                    data-testid={`remove-${member.username}`}
                    className="min-h-11 px-2 text-[12px] text-red-300"
                  >
                    {self ? zhTW.settings.leave : zhTW.settings.remove}
                  </button>
                ) : lastOwner ? (
                  <span className="text-[11px] text-ink-dim" data-testid="last-owner">
                    {zhTW.settings.lastOwner}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ErrorLine failure={failure} />

      {confirming ? (
        <div className="rounded-2xl border border-line bg-surface p-4" data-testid="remove-confirm">
          <p className="mb-1 text-[15px] font-medium">
            {confirming.userId === me
              ? zhTW.settings.leaveTitle
              : interpolate(zhTW.settings.removeTitle, { name: confirming.username })}
          </p>
          <p className="mb-3 text-xs leading-relaxed text-ink-faint">
            {confirming.userId === me ? zhTW.settings.leaveBody : zhTW.settings.removeBody}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="min-h-11 flex-1 rounded-xl border border-line text-sm text-ink-muted"
            >
              {zhTW.addEvent.cancel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove(confirming)}
              data-testid="remove-yes"
              className="min-h-11 flex-1 rounded-xl bg-red-400/90 text-sm font-bold text-ground disabled:opacity-60"
            >
              {confirming.userId === me ? zhTW.settings.leaveYes : zhTW.settings.removeYes}
            </button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
