// Windows shell properties are separate from WM_SETICON.
// Supply a durable icon resource and the installed package identity.
export const taskbarPropertySource = String.raw`using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct IconPropertyKey {
 public Guid fmtid; public uint pid;
 public IconPropertyKey(uint p){fmtid=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");pid=p;}
}
[StructLayout(LayoutKind.Explicit,Size=24)] public struct IconPropertyValue {
 [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr;
}
[ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IconPropertyStore {
 [PreserveSig] int GetCount(out uint c);
 [PreserveSig] int GetAt(uint i,out IconPropertyKey k);
 [PreserveSig] int GetValue(ref IconPropertyKey k,out IconPropertyValue v);
 [PreserveSig] int SetValue(ref IconPropertyKey k,ref IconPropertyValue v);
 [PreserveSig] int Commit();
}
public class CodexSkinTaskbar {
 [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h,ref Guid g,out IconPropertyStore s);
 public static void Set(IntPtr h,uint p,string text){
  var g=typeof(IconPropertyStore).GUID; IconPropertyStore s;
  Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(h,ref g,out s));
  var k=new IconPropertyKey(p); var v=new IconPropertyValue{vt=31,ptr=Marshal.StringToCoTaskMemUni(text)};
  try{Marshal.ThrowExceptionForHR(s.SetValue(ref k,ref v));Marshal.ThrowExceptionForHR(s.Commit());}
  finally{Marshal.FreeCoTaskMem(v.ptr);Marshal.ReleaseComObject(s);}
 }
}
`;
