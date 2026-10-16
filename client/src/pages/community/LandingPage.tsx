import { Link } from 'react-router-dom';
import { AuthSplitLayout } from '../../components/community.tsx';

/** `/` for signed-out visitors: the way in to signup or sign-in. */
export function LandingPage() {
  return (
    <AuthSplitLayout>
      <h2 className="text-2xl font-bold text-navy-800">Join the ECenter community</h2>
      <p className="mt-2 text-sm text-slate-500">
        A place for UNH students and mentors to find each other, share news and set up conversations that help ideas
        grow. Signing up takes about two minutes.
      </p>
      <div className="mt-8 space-y-3">
        <Link to="/signup" className="btn-primary w-full">
          Create an account
        </Link>
        <Link to="/login" className="btn-ghost w-full">
          Sign in
        </Link>
      </div>
    </AuthSplitLayout>
  );
}
