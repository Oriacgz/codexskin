param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BrandIconResources {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string path,bool delete);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateResource(IntPtr update,IntPtr type,IntPtr name,ushort language,byte[] data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool EndUpdateResource(IntPtr update,bool discard);
 static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static void Apply(string path,string icon){
  byte[] bytes=File.ReadAllBytes(icon);ushort count=BitConverter.ToUInt16(bytes,4);
  if(count==0||BitConverter.ToUInt16(bytes,2)!=1)throw new InvalidDataException("Expected ICO");
  var group=new byte[6+14*count];Array.Copy(bytes,group,6);
  IntPtr update=BeginUpdateResource(path,false);if(update==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
  bool committed=false;
  try{
   for(int i=0;i<count;i++){
    int entry=6+16*i;int size=BitConverter.ToInt32(bytes,entry+8);int offset=BitConverter.ToInt32(bytes,entry+12);
    byte[] frame=new byte[size];Array.Copy(bytes,offset,frame,0,size);
    ushort id=(ushort)(100+i);Check(UpdateResource(update,(IntPtr)3,(IntPtr)id,1033,frame,(uint)size));
    Array.Copy(bytes,entry,group,6+14*i,12);Array.Copy(BitConverter.GetBytes(id),0,group,6+14*i+12,2);
   }
   // Node's primary icon group is resource 1; other resources, including SEA, remain intact.
   Check(UpdateResource(update,(IntPtr)14,(IntPtr)1,1033,group,(uint)group.Length));
   Check(EndUpdateResource(update,false));committed=true;
  }finally{if(!committed)EndUpdateResource(update,true);}
 }
}
'@
[BrandIconResources]::Apply([IO.Path]::GetFullPath($Executable),[IO.Path]::GetFullPath($Icon))
